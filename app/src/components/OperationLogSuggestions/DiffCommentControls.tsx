import { useRef, useState, type ReactNode } from 'react'
import type { CellDiff } from '../../lib/notebookDiff/model'
import {
  createDiffCommentTarget,
  type DiffCommentTarget,
} from '../../lib/operationLog/diffCommentAnchor'
import { captureDiffSelection } from './diffSelection'

/** Cell actions and selection/context-menu actions share a frozen target.
 * The parent owns the composer; switching revisions remounts this selection state.
 */
export function DiffCommentControls({
  row,
  disabled,
  onComment,
  children,
}: {
  row: CellDiff
  disabled: boolean
  onComment: (target: DiffCommentTarget) => void
  children: ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<DiffCommentTarget>()
  const [error, setError] = useState('')
  const [menu, setMenu] = useState(false)
  const capture = () => {
    try {
      setSelection(captureDiffSelection(root.current!, row))
      setError('')
    } catch (e) {
      setSelection(undefined)
      setError((e as Error).message)
    }
  }
  const start = (target: DiffCommentTarget) => {
    if (disabled) return
    onComment(target)
    setMenu(false)
  }
  const wholeCell = (side?: 'base' | 'head') =>
    createDiffCommentTarget(
      [row],
      (row.compareCell ?? row.baseCell)!.refId,
      side
    )
  return (
    <div id={`diff-comment-controls-${row.id}`}>
      <div className="mb-1 flex flex-wrap gap-2 text-xs">
        <button disabled={disabled} onClick={() => start(wholeCell())}>
          Comment on cell
        </button>
        {row.baseCell && row.compareCell && row.kind !== 'unchanged' && (
          <button disabled={disabled} onClick={() => start(wholeCell('base'))}>
            Comment on previous cell
          </button>
        )}
        {selection && (
          <button disabled={disabled} onClick={() => start(selection)}>
            Comment on selection
          </button>
        )}
      </div>
      <div
        id={`diff-selectable-${row.id}`}
        ref={root}
        tabIndex={0}
        aria-label="Selectable cell diff"
        onMouseUp={capture}
        onKeyUp={capture}
        onContextMenu={(event) => {
          if (disabled) return
          event.preventDefault()
          capture()
          setMenu(true)
        }}
      >
        {children}
      </div>
      {menu && (
        <div
          role="menu"
          aria-label="Diff comments"
          className="my-1 rounded border bg-white p-2 text-sm"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setMenu(false)
          }}
        >
          <button
            role="menuitem"
            disabled={disabled || Boolean(error)}
            autoFocus
            onClick={() => start(selection ?? wholeCell())}
          >
            {selection ? 'Comment on selection' : 'Comment on cell'}
          </button>
          <button
            role="menuitem"
            className="ml-3"
            onClick={() => setMenu(false)}
          >
            Cancel
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  )
}
