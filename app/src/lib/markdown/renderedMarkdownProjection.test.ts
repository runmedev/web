// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import {
  buildRenderedMarkdownProjection,
  captureRenderedMarkdownSelection,
  sliceByCodePoint,
  sourceRangesForProjectionRange,
  utf16OffsetToCodePointOffset,
} from './renderedMarkdownProjection'

describe('rendered Markdown projection', () => {
  it('projects rendered text without Markdown syntax', () => {
    const source = 'Read **the [migration guide](https://example.com)** today.'

    const projection = buildRenderedMarkdownProjection(source)

    expect(projection.text).toBe('Read the migration guide today.')
    expect(projection.segments).toEqual([
      {
        projectionStart: 0,
        projectionEnd: 5,
        sourceRanges: [{ start: 0, end: 5 }],
      },
      {
        projectionStart: 5,
        projectionEnd: 9,
        sourceRanges: [{ start: 7, end: 11 }],
      },
      {
        projectionStart: 9,
        projectionEnd: 24,
        sourceRanges: [{ start: 12, end: 27 }],
      },
      {
        projectionStart: 24,
        projectionEnd: 31,
        sourceRanges: [{ start: 51, end: 58 }],
      },
    ])
    expect(sourceRangesForProjectionRange(projection, source, 9, 18)).toEqual([
      { start: 12, end: 21 },
    ])
  })

  it('maps a browser Range through annotated text spans', () => {
    const source = 'Read **the [migration guide](https://example.com)** today.'
    const projection = buildRenderedMarkdownProjection(source)
    const root = document.createElement('div')
    root.innerHTML = [
      '<span data-runme-projection-start="0" data-runme-projection-end="5" data-runme-source-start="0" data-runme-source-end="5">Read </span>',
      '<strong><span data-runme-projection-start="5" data-runme-projection-end="9" data-runme-source-start="7" data-runme-source-end="11">the </span>',
      '<a><span data-runme-projection-start="9" data-runme-projection-end="24" data-runme-source-start="12" data-runme-source-end="27">migration guide</span></a></strong>',
      '<span data-runme-projection-start="24" data-runme-projection-end="31" data-runme-source-start="51" data-runme-source-end="58"> today.</span>',
    ].join('')
    document.body.append(root)
    const spans = root.querySelectorAll('span')
    const range = document.createRange()
    range.setStart(spans[1]!.firstChild!, 0)
    range.setEnd(spans[2]!.firstChild!, 'migration guide'.length)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    const target = captureRenderedMarkdownSelection({
      root,
      selection,
      cellId: 'cell-1',
      source,
      projection,
    })

    expect(target).toMatchObject({
      type: 'cell-text',
      cellId: 'cell-1',
      surface: 'rendered-markdown',
      selectors: [
        { type: 'TextPositionSelector', start: 5, end: 24 },
        { type: 'TextQuoteSelector', exact: 'the migration guide' },
      ],
      sourceHints: [
        { start: 7, end: 11 },
        { start: 12, end: 27 },
      ],
    })
  })

  it('uses Unicode code points for selector positions', () => {
    const value = 'A😀B'

    expect(utf16OffsetToCodePointOffset(value, 3)).toBe(2)
    expect(sliceByCodePoint(value, 1, 2)).toBe('😀')
    expect(() => utf16OffsetToCodePointOffset(value, 2)).toThrow(
      'surrogate pair'
    )
  })

  it('rejects selection endpoints inside a grapheme cluster', () => {
    const source = 'A👍🏽B'
    const projection = buildRenderedMarkdownProjection(source)
    const root = document.createElement('div')
    root.innerHTML = `<span data-runme-projection-start="0" data-runme-projection-end="4">${source}</span>`
    document.body.append(root)
    const text = root.querySelector('span')!.firstChild!
    const range = document.createRange()
    range.setStart(text, 1)
    range.setEnd(text, 3)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    expect(
      captureRenderedMarkdownSelection({
        root,
        selection,
        cellId: 'cell-1',
        source,
        projection,
      })
    ).toBeNull()

    range.setEnd(text, 5)
    selection.removeAllRanges()
    selection.addRange(range)
    expect(
      captureRenderedMarkdownSelection({
        root,
        selection,
        cellId: 'cell-1',
        source,
        projection,
      })
    ).toMatchObject({
      selectors: [
        { type: 'TextPositionSelector', start: 1, end: 3 },
        { type: 'TextQuoteSelector', exact: '👍🏽' },
      ],
    })
  })

  it('captures selections in large rendered cells without quadratic work', () => {
    const source = 'a'.repeat(20_000)
    const projection = buildRenderedMarkdownProjection(source)
    const root = document.createElement('div')
    root.innerHTML = `<span data-runme-projection-start="0" data-runme-projection-end="${source.length}">${source}</span>`
    document.body.append(root)
    const text = root.querySelector('span')!.firstChild!
    const range = document.createRange()
    range.setStart(text, source.length - 20)
    range.setEnd(text, source.length - 10)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    const started = performance.now()
    const target = captureRenderedMarkdownSelection({
      root,
      selection,
      cellId: 'cell-1',
      source,
      projection,
    })
    const elapsedMs = performance.now() - started

    expect(target?.selectors[0]).toEqual({
      type: 'TextPositionSelector',
      start: source.length - 20,
      end: source.length - 10,
    })
    expect(elapsedMs).toBeLessThan(500)
  })

  it('maps element-container boundaries to annotated child spans', () => {
    const source = 'one two'
    const projection = buildRenderedMarkdownProjection(source)
    const root = document.createElement('div')
    root.innerHTML = [
      '<span data-runme-projection-start="0" data-runme-projection-end="4" data-runme-source-start="0" data-runme-source-end="4">one </span>',
      '<span data-runme-projection-start="4" data-runme-projection-end="7" data-runme-source-start="4" data-runme-source-end="7">two</span>',
    ].join('')
    document.body.append(root)
    const range = document.createRange()
    range.setStart(root, 1)
    range.setEnd(root, 2)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    expect(
      captureRenderedMarkdownSelection({
        root,
        selection,
        cellId: 'cell-1',
        source,
        projection,
      })
    ).toMatchObject({
      selectors: [
        { type: 'TextPositionSelector', start: 4, end: 7 },
        { type: 'TextQuoteSelector', exact: 'two' },
      ],
    })
  })

  it('respects child offsets when an annotated span is the range container', () => {
    const source = 'one two'
    const projection = buildRenderedMarkdownProjection(source)
    const root = document.createElement('div')
    root.innerHTML = [
      '<span data-runme-projection-start="0" data-runme-projection-end="4">one </span>',
      '<span data-runme-projection-start="4" data-runme-projection-end="7">two</span>',
    ].join('')
    document.body.append(root)
    const spans = root.querySelectorAll('span')
    const range = document.createRange()
    range.setStart(spans[0]!, 1)
    range.setEnd(spans[1]!, 1)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    expect(
      captureRenderedMarkdownSelection({
        root,
        selection,
        cellId: 'cell-1',
        source,
        projection,
      })
    ).toMatchObject({
      selectors: [
        { type: 'TextPositionSelector', start: 4, end: 7 },
        { type: 'TextQuoteSelector', exact: 'two' },
      ],
    })

    range.setStart(spans[0]!, 0)
    range.setEnd(spans[1]!, 0)
    selection.removeAllRanges()
    selection.addRange(range)

    expect(
      captureRenderedMarkdownSelection({
        root,
        selection,
        cellId: 'cell-1',
        source,
        projection,
      })
    ).toMatchObject({
      selectors: [
        { type: 'TextPositionSelector', start: 0, end: 4 },
        { type: 'TextQuoteSelector', exact: 'one ' },
      ],
    })
  })
})
