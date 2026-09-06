import { useState } from 'react'
import type { parser_pb } from '../../runme/client'
import {
  reviewOutlineSections,
  reviewSectionCellIds,
} from '../../lib/operationLog/reviewScope'

/** UI ranges resolve to cell IDs immediately. The persisted review need not be
 * contiguous; start/end outlines are alternative ways to select its cells.
 */
export function ReviewScopePicker({
  before,
  after,
  disabled,
  onChange,
}: {
  before: parser_pb.Notebook
  after: parser_pb.Notebook
  disabled: boolean
  onChange: (cellIds: string[] | undefined) => void
}) {
  const [mode, setMode] = useState<'all' | 'range'>('all')
  const [side, setSide] = useState<'base' | 'head'>('head')
  const [from, setFrom] = useState('')
  const [through, setThrough] = useState('')
  const notebook = side === 'head' ? after : before
  const sections = reviewOutlineSections(notebook)
  const start = sections.find((s) => s.key === from) ?? sections[0]
  const ends = start ? sections.slice(sections.indexOf(start)) : []
  const end = ends.find((s) => s.key === through) ?? start
  const selectedIds =
    start && end ? reviewSectionCellIds(notebook, start.key, end.key) : []
  const selectRange = (nextFrom: string, nextThrough: string) => {
    setFrom(nextFrom)
    setThrough(nextThrough)
    onChange(reviewSectionCellIds(notebook, nextFrom, nextThrough))
  }
  return (
    <fieldset
      id="review-cell-scope-picker"
      disabled={disabled}
      className="space-y-2 border-t pt-3"
    >
      <legend className="text-sm font-medium">Suggestion scope</legend>
      <label className="block text-sm">
        <input
          type="radio"
          name="review-scope"
          checked={mode === 'all'}
          onChange={() => {
            setMode('all')
            onChange(undefined)
          }}
        />{' '}
        Whole document
      </label>
      <label className="block text-sm">
        <input
          type="radio"
          name="review-scope"
          checked={mode === 'range'}
          onChange={() => {
            setMode('range')
            onChange(selectedIds)
          }}
        />{' '}
        Heading / section range
      </label>
      {mode === 'range' && (
        <>
          <label className="block text-sm">
            Outline from
            <select
              aria-label="Scope outline revision"
              className="mt-1 w-full rounded border p-2"
              value={side}
              onChange={(e) => {
                const nextSide = e.target.value as 'base' | 'head'
                const nextNotebook = nextSide === 'head' ? after : before
                const first = reviewOutlineSections(nextNotebook)[0]
                setSide(nextSide)
                setFrom(first?.key ?? '')
                setThrough(first?.key ?? '')
                onChange(
                  first
                    ? reviewSectionCellIds(nextNotebook, first.key, first.key)
                    : []
                )
              }}
            >
              <option value="head">End revision</option>
              <option value="base">
                Start revision (includes deleted sections)
              </option>
            </select>
          </label>
          {start && end ? (
            <>
              <label className="block text-sm">
                From heading
                <select
                  aria-label="From heading"
                  className="mt-1 w-full rounded border p-2"
                  value={start.key}
                  onChange={(e) => selectRange(e.target.value, e.target.value)}
                >
                  {sections.map((s) => (
                    <option key={s.key} value={s.key}>
                      {'　'.repeat(s.level - 1)}
                      {s.text} · Cell {s.startIndex + 1}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                Through section
                <select
                  aria-label="Through section"
                  className="mt-1 w-full rounded border p-2"
                  value={end.key}
                  onChange={(e) => selectRange(start.key, e.target.value)}
                >
                  {ends.map((s) => (
                    <option key={s.key} value={s.key}>
                      {'　'.repeat(s.level - 1)}
                      {s.text} · Cell {s.startIndex + 1}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-xs text-nb-text-muted">
                {selectedIds.length} cells selected. Includes subheadings and
                their body cells. Selections use whole cells; headings sharing a
                cell cannot be separated.
              </p>
            </>
          ) : (
            <p role="status" className="text-xs">
              No headings in this revision. Choose the other outline or review
              the whole document.
            </p>
          )}
        </>
      )}
    </fieldset>
  )
}
