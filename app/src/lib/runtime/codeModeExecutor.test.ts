// @vitest-environment jsdom
import { create } from '@bufbuild/protobuf'
import { describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../../runme/client'
import { appLogger } from '../logging/runtime'
import {
  createCodeModeExecutor,
  getCodeModeErrorOutput,
} from './codeModeExecutor'

const createNotebook = () => {
  const notebook = create(parser_pb.NotebookSchema, {
    cells: [],
  })
  return {
    getUri: () => 'local://test.runme.md',
    getName: () => 'test.runme.md',
    getNotebook: () => notebook,
    updateCell: () => {},
    getCell: () => null,
  }
}

describe('codeModeExecutor', () => {
  it('merges stdout and stderr into one ordered output string', async () => {
    const infoSpy = vi.spyOn(appLogger, 'info')
    const notebook = createNotebook()
    const executor = createCodeModeExecutor({
      mode: 'browser',
      resolveNotebook: () => notebook,
      listNotebooks: () => [notebook],
    })

    const result = await executor.execute({
      source: 'chatkit',
      code: "console.log('one'); console.error('two'); console.log('three');",
    })

    expect(result.output).toContain('one')
    expect(result.output).toContain('two')
    expect(result.output).toContain('three')
    expect(result.output.indexOf('one')).toBeLessThan(
      result.output.indexOf('two')
    )
    expect(result.output.indexOf('two')).toBeLessThan(
      result.output.indexOf('three')
    )
    const started = infoSpy.mock.calls.find(
      ([message]) => message === 'Code mode execution started'
    )
    const completed = infoSpy.mock.calls.find(
      ([message]) => message === 'Code mode execution completed'
    )
    expect(started?.[1]?.attrs?.code).toContain("console.log('one')")
    expect(completed?.[1]?.attrs?.output).toContain('one')
    expect(completed?.[1]?.attrs?.output).toContain('two')
    expect(completed?.[1]?.attrs?.output).toContain('three')
    infoSpy.mockRestore()
  })

  it('truncates output when it exceeds the configured output budget', async () => {
    const notebook = createNotebook()
    const executor = createCodeModeExecutor({
      mode: 'browser',
      maxOutputBytes: 20,
      resolveNotebook: () => notebook,
      listNotebooks: () => [notebook],
    })

    const result = await executor.execute({
      source: 'chatkit',
      code: "console.log('abcdefghijklmnopqrstuvwxyz');",
    })

    expect(result.output).toContain('[output truncated]')
  })

  it('returns partial output when execution times out', async () => {
    const notebook = createNotebook()
    const executor = createCodeModeExecutor({
      mode: 'browser',
      timeoutMs: 20,
      resolveNotebook: () => notebook,
      listNotebooks: () => [notebook],
    })

    try {
      await executor.execute({
        source: 'codex',
        code: "console.log('started'); await new Promise(() => {});",
      })
      expect.fail('expected timeout error')
    } catch (error) {
      expect(String(error)).toMatch(/timed out/)
      expect(getCodeModeErrorOutput(error)).toContain('started')
    }
  })
})
