// @vitest-environment jsdom
import { create } from '@bufbuild/protobuf'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parser_pb } from '../../runme/client'
import {
  buildRenderedMarkdownProjection,
  sliceByCodePoint,
} from '../markdown/renderedMarkdownProjection'
import { createRenderedMarkdownUiApi } from './renderedMarkdownUi'
import type { NotebookDataLike } from './runmeConsole'

const uri = 'local://comments-fixture.ipynb'
const cellId = 'markdown-cell-1'
const source = 'Read **the [migration guide](https://example.com)** today.'

function createNotebook(): NotebookDataLike {
  const notebook = create(parser_pb.NotebookSchema, {
    cells: [
      create(parser_pb.CellSchema, {
        refId: cellId,
        kind: parser_pb.CellKind.MARKUP,
        languageId: 'markdown',
        value: source,
      }),
    ],
  })
  return {
    getUri: () => uri,
    getName: () => 'comments-fixture.ipynb',
    getNotebook: () => notebook,
    updateCell: () => undefined,
    getCell: () => null,
  }
}

function renderProjection(): HTMLElement {
  const projection = buildRenderedMarkdownProjection(source)
  const root = document.createElement('div')
  root.dataset.runmeCellId = cellId
  root.dataset.runmeSurface = 'rendered-markdown'
  root.dataset.runmeProjection = 'runme-markdown-text@1'
  for (const segment of projection.segments) {
    const span = document.createElement('span')
    span.dataset.runmeProjectionStart = String(segment.projectionStart)
    span.dataset.runmeProjectionEnd = String(segment.projectionEnd)
    span.textContent = sliceByCodePoint(
      projection.text,
      segment.projectionStart,
      segment.projectionEnd
    )
    root.appendChild(span)
  }
  const panel = document.createElement('div')
  panel.dataset.documentId = uri
  panel.dataset.state = 'active'
  const notebook = document.createElement('div')
  notebook.dataset.documentId = uri
  notebook.appendChild(root)
  panel.appendChild(notebook)
  document.body.appendChild(panel)
  return root
}

describe('createRenderedMarkdownUiApi', () => {
  beforeEach(() => {
    document.body.replaceChildren()
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 10,
        right: 80,
        top: 20,
        bottom: 40,
        width: 70,
        height: 20,
        x: 10,
        y: 20,
        toJSON: () => ({}),
      }),
    })
  })

  afterEach(() => {
    document.getSelection()?.removeAllRanges()
  })

  it('creates and clears a browser selection from a rendered TextQuoteSelector', () => {
    renderProjection()
    const api = createRenderedMarkdownUiApi({
      getCurrentNotebook: () => createNotebook(),
    })

    const result = api.selectRenderedMarkdown({
      target: { uri },
      cellId,
      selector: {
        type: 'TextQuoteSelector',
        exact: 'migration guide',
        prefix: 'Read the ',
        suffix: ' today.',
      },
    })

    expect(document.getSelection()?.toString()).toBe('migration guide')
    expect(result).toMatchObject({
      cellId,
      surface: 'rendered-markdown',
      projection: { name: 'runme-markdown-text', version: 1 },
      selectors: [
        { type: 'TextPositionSelector', start: 9, end: 24 },
        { type: 'TextQuoteSelector', exact: 'migration guide' },
      ],
    })
    expect(api.clearSelection()).toMatchObject({
      cleared: true,
      previousRangeCount: 1,
      rangeCount: 0,
      isCollapsed: true,
    })
  })

  it('opens the same rendered-selection context menu handled by the cell', async () => {
    const root = renderProjection()
    root.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      const menu = document.createElement('div')
      menu.dataset.runmeContextMenuCellId = cellId
      menu.dataset.runmeContextMenuKind = 'rendered-selection'
      const action = document.createElement('button')
      action.dataset.runmeContextMenuAction = 'comment-selection'
      menu.appendChild(action)
      root.closest('[data-document-id]')?.appendChild(menu)
    })
    const api = createRenderedMarkdownUiApi({
      getCurrentNotebook: () => createNotebook(),
    })

    const result = await api.prepareRenderedComment({
      target: { uri },
      cellId,
      selector: {
        type: 'TextQuoteSelector',
        exact: 'migration guide',
        prefix: 'Read the ',
        suffix: ' today.',
      },
    })

    expect(result).toMatchObject({
      opened: true,
      defaultPrevented: true,
      cellId,
      action: 'comment-selection',
    })
  })

  it('fails closed for an ambiguous quote or a non-active notebook', () => {
    const duplicateSource = 'same and same'
    const notebook = createNotebook()
    notebook.getNotebook().cells[0].value = duplicateSource
    const projection = buildRenderedMarkdownProjection(duplicateSource)
    const root = document.createElement('div')
    root.dataset.runmeCellId = cellId
    root.dataset.runmeSurface = 'rendered-markdown'
    root.dataset.runmeProjection = 'runme-markdown-text@1'
    const span = document.createElement('span')
    span.dataset.runmeProjectionStart = '0'
    span.dataset.runmeProjectionEnd = String(Array.from(projection.text).length)
    span.textContent = projection.text
    root.appendChild(span)
    const panel = document.createElement('div')
    panel.dataset.documentId = uri
    panel.appendChild(root)
    document.body.appendChild(panel)
    const api = createRenderedMarkdownUiApi({
      getCurrentNotebook: () => notebook,
    })

    expect(() =>
      api.selectRenderedMarkdown({
        target: { uri },
        cellId,
        selector: { type: 'TextQuoteSelector', exact: 'same' },
      })
    ).toThrow('ambiguous')
    expect(() =>
      api.selectRenderedMarkdown({
        target: { uri: 'local://other.ipynb' },
        cellId,
        selector: { type: 'TextQuoteSelector', exact: 'same' },
      })
    ).toThrow('is not the active notebook')
  })
})
