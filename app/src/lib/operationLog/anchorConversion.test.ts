import { describe, expect, it } from 'vitest'

import {
  RENDERED_MARKDOWN_PROJECTION_NAME,
  buildRenderedMarkdownProjection,
  sha256Text,
} from '../markdown/renderedMarkdownProjection'
import { sourceAnchorsFromLegacy } from './anchorConversion'
import { createRunmeOperation } from './mutations'
import { anchorSource } from './versions'

describe('historical rendered selections', () => {
  it('verifies the projection and converts rendered emoji offsets to source anchors', async () => {
    const source = '**A😀B**'
    const operation = createRunmeOperation({
      actorId: 'a',
      actorSequence: 1,
      dependencies: [],
      knownOperations: [],
      kind: 'cell.create',
      payload: {
        cell_id: 'c',
        position: [[100, 'a', 1]],
        cell: {
          kind: 'markup',
          language_id: 'markdown',
          value: source,
          metadata: {},
        },
      },
    })
    const projection = buildRenderedMarkdownProjection(source)
    const start = Array.from(projection.text).indexOf('😀')
    const target = {
      type: 'cell-text',
      cellId: 'c',
      state: {
        sourceSha256: await sha256Text(source),
        projection: {
          name: RENDERED_MARKDOWN_PROJECTION_NAME,
          version: projection.version,
          sha256: await sha256Text(projection.text),
        },
      },
      selectors: [
        { type: 'TextPositionSelector', start, end: start + 1 },
        { type: 'TextQuoteSelector', exact: '😀' },
      ],
    }
    const version = { kind: 'operation' as const, op_id: operation.op_id }
    const anchors = await sourceAnchorsFromLegacy([operation], target, version)
    expect(anchors).toHaveLength(1)
    expect(anchors[0]).toMatchObject({
      range: { start_index: 3, end_index: 4, unit: 'unicode-code-point' },
    })
    expect(anchorSource([operation], anchors[0])).toBe('😀')
    await expect(
      sourceAnchorsFromLegacy(
        [operation],
        {
          ...target,
          state: {
            ...target.state,
            projection: { ...target.state.projection, version: 99 },
          },
        },
        version
      )
    ).rejects.toThrow('projection')
    await expect(
      sourceAnchorsFromLegacy(
        [operation],
        { ...target, state: { ...target.state, sourceSha256: 'stale' } },
        version
      )
    ).rejects.toThrow('source')
  })
})
