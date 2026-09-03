/// <reference types="vitest" />
// @vitest-environment node
import { create } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MimeType, parser_pb } from '../runme/client'
import { appLogger } from './logging/runtime'
import {
  createInitialNotebookFile,
  decodeNotebookFile,
  detectNotebookFileFormat,
  encodeRunmeNotebook,
  inspectRunmeNotebookJsonShape,
} from './notebookFormat'
import {
  type NotebookLogHeader,
  createRunmeOperation,
  serializeOperationLog,
} from './operationLog'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('notebook file format recovery', () => {
  it('recovers Runme protobuf JSON mislabeled as IPYNB without losing cells', () => {
    const cells = Array.from({ length: 15 }, (_, index) =>
      create(parser_pb.CellSchema, {
        refId: `cell-${index}`,
        kind:
          index % 2 === 0 ? parser_pb.CellKind.MARKUP : parser_pb.CellKind.CODE,
        languageId: index % 2 === 0 ? 'markdown' : 'bash',
        value: `cell value ${index}`,
        metadata: {
          name: `cell-name-${index}`,
          ...(index === 1 ? { 'runme.dev/runnerName': 'local' } : {}),
        },
        outputs:
          index === 1
            ? [
                create(parser_pb.CellOutputSchema, {
                  metadata: { 'runme.dev/customOutput': 'preserve-me' },
                  items: [
                    create(parser_pb.CellOutputItemSchema, {
                      mime: MimeType.VSCodeNotebookStdOut,
                      type: 'TerminalBuffer',
                      data: new TextEncoder().encode('preserved output\n'),
                    }),
                  ],
                  processInfo: create(parser_pb.CellOutputProcessInfoSchema, {
                    pid: 4242n,
                    exitReason: create(parser_pb.ProcessInfoExitReasonSchema, {
                      type: 'exit',
                      code: 0,
                    }),
                  }),
                }),
              ]
            : [],
        executionSummary:
          index === 1
            ? create(parser_pb.CellExecutionSummarySchema, {
                executionOrder: 17,
                success: true,
                timing: create(parser_pb.ExecutionSummaryTimingSchema, {
                  startTime: 100n,
                  endTime: 250n,
                }),
              })
            : undefined,
      })
    )
    const source = create(parser_pb.NotebookSchema, {
      cells,
      metadata: {
        'runme.dev/ipynb': 'true',
        'runme.dev/notebookSetting': 'preserve-me',
      },
    })
    const malformedIpynb = encodeRunmeNotebook(source)
    const warn = vi
      .spyOn(appLogger, 'warn')
      .mockImplementation(() => null as never)

    const decoded = decodeNotebookFile(
      malformedIpynb,
      'codex_instructions.ipynb'
    )

    expect(decoded.recovery).toEqual({
      sourceFormat: 'runme-json',
      reason: 'ipynb-content-mismatch',
      cellCount: 15,
    })
    expect(decoded.notebook.cells).toHaveLength(15)
    expect(decoded.notebook.cells.map((cell) => cell.value)).toEqual(
      cells.map((cell) => cell.value)
    )
    expect(decoded.notebook.cells[1]?.metadata).toMatchObject({
      name: 'cell-name-1',
      'runme.dev/runnerName': 'local',
    })
    expect(decoded.notebook.cells[1]?.outputs[0]?.items[0]?.data).toEqual(
      new TextEncoder().encode('preserved output\n')
    )
    expect(decoded.notebook.cells[1]?.outputs[0]).toMatchObject({
      metadata: { 'runme.dev/customOutput': 'preserve-me' },
      items: [{ type: 'TerminalBuffer' }],
      processInfo: {
        pid: 4242n,
        exitReason: { type: 'exit', code: 0 },
      },
    })
    expect(decoded.notebook.cells[1]?.executionSummary).toMatchObject({
      executionOrder: 17,
      success: true,
      timing: { startTime: 100n, endTime: 250n },
    })
    expect(decoded.notebook.metadata['runme.dev/notebookSetting']).toBe(
      'preserve-me'
    )

    const repaired = JSON.parse(decoded.ipynb?.shadowText ?? '')
    expect(repaired).toMatchObject({ nbformat: 4, nbformat_minor: 5 })
    expect(repaired.cells).toHaveLength(15)
    expect(repaired.cells[0]).toMatchObject({
      cell_type: 'markdown',
      id: 'cell-0',
      source: 'cell value 0',
    })
    expect(repaired.cells[0]).not.toHaveProperty('kind')
    expect(() =>
      decodeNotebookFile(decoded.ipynb?.shadowText ?? '', 'repaired.ipynb')
    ).not.toThrow()
    expect(warn).toHaveBeenCalledWith(
      'Recovered IPYNB from Runme JSON content',
      {
        attrs: {
          scope: 'notebook.format',
          code: 'IPYNB_RUNME_JSON_RECOVERY',
          sourceFormat: 'runme-json',
          reason: 'ipynb-content-mismatch',
          cellCount: 15,
        },
      }
    )
  })

  it('requires positive Runme evidence before recovering malformed IPYNB', () => {
    const ambiguous = JSON.stringify({
      cells: [{ metadata: {} }],
      metadata: {},
    })
    const mixed = JSON.stringify({
      cells: [{ kind: 'CELL_KIND_MARKUP', source: '# mixed schemas' }],
      metadata: { 'runme.dev/ipynb': 'true' },
    })

    expect(inspectRunmeNotebookJsonShape(ambiguous)).toEqual({
      cellCount: 1,
      hasRunmeEvidence: false,
    })
    expect(inspectRunmeNotebookJsonShape(mixed)).toBeNull()
    expect(() => decodeNotebookFile(ambiguous, 'ambiguous.ipynb')).toThrow(
      'Unsupported Jupyter nbformat major version: undefined'
    )
    expect(() => decodeNotebookFile(mixed, 'mixed.ipynb')).toThrow(
      'Unsupported Jupyter nbformat major version: undefined'
    )
  })
})

describe('Runme operation-log format', () => {
  it('detects .runme independently from existing JSON and IPYNB formats', () => {
    expect(detectNotebookFileFormat('notebook.runme')).toBe(
      'runme-operation-log'
    )
    expect(detectNotebookFileFormat('notebook.json')).toBe('runme-json')
    expect(detectNotebookFileFormat('notebook.ipynb')).toBe('ipynb')
  })

  it('creates a valid empty .runme document', () => {
    const decoded = decodeNotebookFile(
      createInitialNotebookFile('new.runme'),
      'new.runme'
    )
    expect(decoded.format).toBe('runme-operation-log')
    expect(decoded.operationLog?.operations).toEqual([])
    expect(decoded.notebook.cells).toEqual([])
  })

  it('decodes materialized cells while retaining the operation log', () => {
    const header: NotebookLogHeader = {
      record_type: 'runme.notebook',
      format_version: 1,
      notebook_id: 'notebook_test',
      created_by: 'actor_seed',
      created_at: '2026-09-03T00:00:00Z',
    }
    const operation = createRunmeOperation({
      actorId: 'actor_seed',
      actorSequence: 1,
      dependencies: [],
      knownOperations: [],
      kind: 'cell.create',
      payload: {
        cell_id: 'cell_one',
        position: [[100, 'actor_seed', 1]],
        cell: {
          kind: 'code',
          language_id: 'python',
          value: 'print(42)',
          metadata: { trusted: true },
        },
      },
      createdAt: '2026-09-03T00:00:01Z',
    })
    const decoded = decodeNotebookFile(
      serializeOperationLog(header, [operation]),
      'example.runme'
    )

    expect(decoded.notebook.cells[0]).toMatchObject({
      refId: 'cell_one',
      kind: parser_pb.CellKind.CODE,
      languageId: 'python',
      value: 'print(42)',
      metadata: { trusted: 'true' },
    })
    expect(decoded.operationLog?.operations).toEqual([operation])
  })
})
