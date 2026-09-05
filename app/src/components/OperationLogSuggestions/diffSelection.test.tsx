import { create } from '@bufbuild/protobuf'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parser_pb } from '../../runme/client'
import type { CellDiff } from '../../lib/notebookDiff/model'
import { ChangedCell } from './OperationLogSuggestionView'
import { DiffCommentControls } from './DiffCommentControls'
import { captureDiffSelection } from './diffSelection'
import {
  createDiffCommentTarget,
  parseDiffCommentTarget,
} from '../../lib/operationLog/diffCommentAnchor'
import { createReviewAnchor } from '../../lib/operationLog/reviews'
import { createSuggestionCommentAnchor } from '../../lib/operationLog/suggestions'

afterEach(() => {
  cleanup()
  document.getSelection()?.removeAllRanges()
})
function fixture(before: string | undefined, after: string | undefined) {
  const cell = (value: string) =>
    create(parser_pb.CellSchema, { refId: 'cell', value })
  const row: CellDiff = {
    id: 'cell',
    kind:
      before === undefined
        ? 'inserted'
        : after === undefined
          ? 'deleted'
          : before === after
            ? 'unchanged'
            : 'modified',
    moved: false,
    changedFields: ['source'],
    baseCell: before === undefined ? undefined : cell(before),
    compareCell: after === undefined ? undefined : cell(after),
  }
  const onComment = vi.fn()
  const view = render(
    <DiffCommentControls row={row} disabled={false} onComment={onComment}>
      <ChangedCell row={row} />
    </DiffCommentControls>
  )
  const root = screen.getByLabelText('Selectable cell diff')
  const runs = [...root.querySelectorAll<HTMLElement>('[data-diff-run]')]
  return { row, onComment, root, runs, ...view }
}
function select(
  start: Node,
  startOffset: number,
  end: Node,
  endOffset: number
) {
  const range = document.createRange()
  range.setStart(start, startOffset)
  range.setEnd(end, endOffset)
  document.getSelection()!.removeAllRanges()
  document.getSelection()!.addRange(range)
}
describe('diff comment selection', () => {
  it.each([
    ['inserted', undefined, 'abc', 'head'],
    ['deleted', 'abc', undefined, 'base'],
    ['unchanged', 'abc', 'abc', 'head'],
  ] as const)('anchors %s source', (_label, before, after, side) => {
    const f = fixture(before, after)
    select(f.runs[0].firstChild!, 1, f.runs[0].firstChild!, 3)
    expect(captureDiffSelection(f.root, f.row)).toEqual({
      cellId: 'cell',
      side,
      quote: 'bc',
      sourceRange: { start: 1, end: 3, unit: 'utf-16' },
    })
    fireEvent.mouseUp(f.root)
    fireEvent.click(
      screen.getByRole('button', { name: 'Comment on selection' })
    )
    expect(f.onComment).toHaveBeenCalledWith(
      expect.objectContaining({ quote: 'bc', side })
    )
  })
  it('maps repeated Unicode text using offsets rather than searching for the quote', () => {
    const f = fixture('😀 repeat repeat', '😀 repeat better repeat')
    const last = f.runs.at(-1)!
    const offset = last.textContent!.lastIndexOf('repeat')
    select(last.firstChild!, offset, last.firstChild!, offset + 6)
    expect(captureDiffSelection(f.root, f.row)).toEqual({
      cellId: 'cell',
      side: 'head',
      quote: 'repeat',
      sourceRange: { start: 17, end: 23, unit: 'utf-16' },
    })
  })
  it('retains old text and rejects mixed deleted/inserted selections', () => {
    const f = fixture('same old end', 'same new end')
    const removed = f.runs.find((r) => r.textContent === 'old')!
    const added = f.runs.find((r) => r.textContent === 'new')!
    select(removed.firstChild!, 0, removed.firstChild!, 3)
    expect(captureDiffSelection(f.root, f.row)?.side).toBe('base')
    select(removed.firstChild!, 0, added.firstChild!, 3)
    expect(() => captureDiffSelection(f.root, f.row)).toThrow('not both')
    fireEvent.contextMenu(f.root)
    expect(screen.getByRole('alert').textContent).toContain('not both')
    expect(f.onComment).not.toHaveBeenCalled()
  })
  it('rejects selections crossing cells and clears a stale selection', () => {
    const f = fixture('abc', 'abc')
    const outside = document.createTextNode('outside')
    document.body.append(outside)
    select(f.runs[0].firstChild!, 0, outside, 3)
    expect(() => captureDiffSelection(f.root, f.row)).toThrow(
      'single diff cell'
    )
    outside.remove()
    document.getSelection()!.removeAllRanges()
    fireEvent.mouseUp(f.root)
    expect(
      screen.queryByRole('button', { name: 'Comment on selection' })
    ).toBeNull()
  })
  it('offers whole-cell and previous-cell comments and a context menu', () => {
    const f = fixture('old', 'new')
    fireEvent.click(
      screen.getByRole('button', { name: 'Comment on previous cell' })
    )
    expect(f.onComment).toHaveBeenLastCalledWith({
      cellId: 'cell',
      side: 'base',
      quote: 'old',
    })
    fireEvent.contextMenu(f.root)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Comment on cell' }))
    expect(f.onComment).toHaveBeenLastCalledWith({
      cellId: 'cell',
      side: 'head',
      quote: 'new',
    })
  })
  it('round trips both anchor kinds and validates ranges', () => {
    const f = fixture('old', 'new')
    const target = createDiffCommentTarget([f.row], 'cell', 'base', {
      start: 0,
      end: 2,
      unit: 'utf-16',
    })
    expect(
      parseDiffCommentTarget(
        createReviewAnchor('round', undefined, undefined, target)
      )
    ).toEqual(target)
    expect(
      parseDiffCommentTarget(
        createSuggestionCommentAnchor('suggestion', target)
      )
    ).toEqual(target)
    expect(() =>
      createDiffCommentTarget([f.row], 'cell', 'head', {
        start: 0,
        end: 9,
        unit: 'utf-16',
      })
    ).toThrow('Invalid diff source range')
    expect(() => createDiffCommentTarget([f.row], 'absent')).toThrow(
      'Cell not found'
    )
  })
})
