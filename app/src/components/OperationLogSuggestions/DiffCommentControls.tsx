import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChatBubbleLeftIcon } from '@heroicons/react/20/solid'
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
  const [menu, setMenu] = useState<{ x: number; y: number }>()
  const menuRoot = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const outside = (event: PointerEvent) => {
      if (!menuRoot.current?.contains(event.target as Node)) setMenu(undefined)
    }
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenu(undefined)
        root.current?.focus()
      }
    }
    window.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('pointerdown', outside)
      window.removeEventListener('keydown', close)
    }
  }, [menu])
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
    setMenu(undefined)
  }
  const wholeCell = (side?: 'base' | 'head') =>
    createDiffCommentTarget(
      [row],
      (row.compareCell ?? row.baseCell)!.refId,
      side
    )
  return (
    <div
      id={`diff-comment-controls-${row.id}`}
      className="relative"
      onContextMenu={(event) => {
        if (disabled) return
        event.preventDefault()
        event.stopPropagation()
        capture()
        setMenu({ x: event.clientX, y: event.clientY })
      }}
      onKeyDown={(event) => {
        if (
          disabled ||
          !(
            event.key === 'ContextMenu' ||
            (event.shiftKey && event.key === 'F10')
          )
        )
          return
        event.preventDefault()
        capture()
        const rect = root.current!.getBoundingClientRect()
        setMenu({ x: rect.left, y: rect.top + 28 })
      }}
    >
      <div
        id={`diff-selectable-${row.id}`}
        ref={root}
        tabIndex={0}
        aria-label="Selectable cell diff"
        className="[&>div]:pr-9"
        onMouseUp={capture}
        onKeyUp={capture}
      >
        {children}
      </div>
      <button
        type="button"
        aria-label="Comment on cell"
        title="Comment on cell"
        disabled={disabled}
        className="icon-btn absolute right-2 top-2 h-6 w-6 text-nb-accent hover:bg-nb-accent-muted hover:text-nb-accent focus-visible:bg-nb-accent-muted focus-visible:text-nb-accent disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() => start(wholeCell())}
      >
        <ChatBubbleLeftIcon className="h-4 w-4" aria-hidden="true" />
      </button>
      {menu &&
        createPortal(
          <div
            ref={menuRoot}
            role="menu"
            aria-label="Diff comments"
            className="ctx-menu w-[220px]"
            style={{
              left: Math.max(0, Math.min(menu.x, window.innerWidth - 228)),
              top: Math.max(0, Math.min(menu.y, window.innerHeight - 140)),
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onKeyDown={(event) => {
              const items = Array.from(
                menuRoot.current!.querySelectorAll<HTMLButtonElement>(
                  'button:not(:disabled)'
                )
              )
              const current = items.indexOf(
                document.activeElement as HTMLButtonElement
              )
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault()
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? items.length - 1
                      : (current +
                          (event.key === 'ArrowDown' ? 1 : -1) +
                          items.length) %
                        items.length
                items[next]?.focus()
              }
              if (event.key === 'Tab') setMenu(undefined)
            }}
          >
            <button
              type="button"
              role="menuitem"
              className="ctx-menu-item"
              disabled={disabled}
              autoFocus
              onClick={() => start(wholeCell())}
            >
              Comment on cell
            </button>
            <button
              type="button"
              role="menuitem"
              className="ctx-menu-item"
              disabled={disabled || !selection || Boolean(error)}
              onClick={() => selection && start(selection)}
            >
              Comment on selection
            </button>
            {row.baseCell && row.compareCell && row.kind !== 'unchanged' && (
              <button
                type="button"
                role="menuitem"
                className="ctx-menu-item"
                disabled={disabled}
                onClick={() => start(wholeCell('base'))}
              >
                Comment on previous cell
              </button>
            )}
          </div>,
          document.body
        )}
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  )
}
