import { describe, expect, it } from 'vitest'

import {
  historicalAnchors,
  locateComment,
  mapSourceRange,
} from './commentAnchorMapping'

describe('historical comment display mapping', () => {
  it('keeps code-point offsets and shifts intact text after an insertion', () => {
    expect(mapSourceRange('A😀B', 'A😀B', 1, 2)).toEqual({
      status: 'exact',
      start: 1,
      end: 2,
    })
    expect(mapSourceRange('A😀B', 'prefix A😀B', 1, 2)).toEqual({
      status: 'mapped',
      start: 8,
      end: 9,
    })
    expect(
      mapSourceRange(
        'one selected passage end',
        'one NEW selected passage end',
        4,
        20
      )
    ).toMatchObject({ status: 'mapped', start: 8, end: 24 })
  })
  it('uses a bounded fuzzy match only with a clear contextual winner', () => {
    expect(
      mapSourceRange('the brown fox runs', 'the brown f0x runs', 4, 13)
    ).toEqual({ status: 'fuzzy', start: 4, end: 13 })
    expect(mapSourceRange('the fox runs', 'the f0x runs', 4, 7)).toEqual({
      status: 'outdated',
    })
    expect(
      mapSourceRange('the brown fox runs', 'entirely different', 4, 13)
    ).toEqual({ status: 'outdated' })
  })
  it('does not choose an arbitrary repeated occurrence', () => {
    const a = 'same context phrase same context'
    const b = `${a}\n${a}`
    expect(mapSourceRange(a, b, 13, 19)).toEqual({ status: 'outdated' })
  })
  it('maps empty selections only when both adjacent boundaries survive', () => {
    expect(mapSourceRange('abcd', 'Xabcd', 2, 2)).toEqual({
      status: 'mapped',
      start: 3,
      end: 3,
    })
    expect(mapSourceRange('abcd', 'abXcd', 2, 2)).toEqual({
      status: 'outdated',
    })
    expect(mapSourceRange('abcd', 'acd', 2, 2)).toEqual({ status: 'outdated' })
  })
  it('fails closed on work limits and invalid ranges', () => {
    expect(mapSourceRange('cafe', 'cafe\u0301', 3, 4)).toEqual({
      status: 'outdated',
    })
    expect(mapSourceRange('e\u0301', 'e\u0301', 0, 1)).toEqual({
      status: 'unavailable',
    })
    expect(
      mapSourceRange('a'.repeat(2000), 'b'.repeat(2000), 100, 120)
    ).toEqual({ status: 'outdated' })
    expect(mapSourceRange('abc', 'abc', -1, 2)).toEqual({
      status: 'unavailable',
    })
  })
  it('derives the source origin for old comparison ranges without duplicating locations', () => {
    const anchor = {
      kind: 'cell',
      cell_id: 'cell',
      surface: 'source',
      version: { kind: 'operation', op_id: 'a:1' },
      range: { start_index: 0, end_index: 2, unit: 'unicode-code-point' },
    }
    const encoded = JSON.stringify({
      runme: {
        comparison: { start: anchor.version, end: anchor.version },
        anchorSources: [{ anchor, source: '**syntax**' }],
      },
    })
    const comment = { anchor: encoded, replies: [{ anchor: encoded }] }
    expect(historicalAnchors(comment)).toEqual([
      {
        anchor: { ...anchor, selection_surface: 'source' },
        source: '**syntax**',
      },
    ])
    expect(comment.anchor).toBe(encoded)
    expect(anchor).not.toHaveProperty('selection_surface')
  })

  it('resolves all root and reply anchors independently on both sides, without mutation', () => {
    const anchor = {
      kind: 'cell',
      cell_id: 'cell',
      surface: 'source',
      version: { kind: 'operation', op_id: 'a:1' },
      range: { start_index: 4, end_index: 13, unit: 'unicode-code-point' },
    }
    const comment = {
      anchor: JSON.stringify({
        runme: { anchorSources: [{ anchor, source: 'the brown fox runs' }] },
      }),
      replies: [
        {
          anchor: JSON.stringify({
            runme: {
              anchorSources: [
                {
                  anchor: { ...anchor, cell_id: 'other' },
                  source: 'the brown fox runs',
                },
              ],
            },
          }),
        },
      ],
    }
    const unchanged = JSON.stringify(comment)
    expect(historicalAnchors(comment)).toHaveLength(2)
    expect(
      locateComment(
        comment,
        [{ refId: 'cell', value: 'the brown fox runs' }],
        'base'
      ).map((l) => l.location.status)
    ).toEqual(['exact', 'deleted'])
    expect(
      locateComment(
        comment,
        [{ refId: 'cell', value: 'the brown f0x runs' }],
        'head'
      )[0]?.location.status
    ).toBe('fuzzy')
    expect(
      locateComment(comment, [
        { refId: 'different', value: 'the brown fox runs' },
      ])[0]?.location.status
    ).toBe('deleted')
    expect(JSON.stringify(comment)).toBe(unchanged)
  })
})
