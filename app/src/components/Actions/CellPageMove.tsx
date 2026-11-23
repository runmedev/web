import { createContext, useCallback, useState, type ReactNode } from 'react'
import type { NotebookPage } from '../../lib/notebookPages'

/** Both the cell menu and Monaco's source menu open the picker for the same cell. */
export const CellPageMoveContext = createContext<(() => void) | undefined>(
  undefined
)

export function CellPageMove({
  destinations,
  move,
  children,
}: {
  destinations: NotebookPage[]
  move: (pageId: string) => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const showPicker = useCallback(() => setOpen(true), [])
  return (
    <CellPageMoveContext.Provider
      value={destinations.length ? showPicker : undefined}
    >
      {children}
      {open && !!destinations.length && (
        <dialog
          aria-label="Move cell to page"
          className="m-auto max-h-[70vh] min-w-48 max-w-[90vw] overflow-auto rounded-nb-md border border-nb-border p-3 shadow-lg"
          ref={(node) => {
            if (node && !node.open) node.showModal()
          }}
          onClose={() => setOpen(false)}
        >
          <h2 className="mb-2 text-sm font-semibold">Move cell to page</h2>
          {destinations.map((page) => (
            <button
              type="button"
              key={page.id}
              className="ctx-menu-item w-full text-left"
              onClick={() => {
                setOpen(false)
                move(page.id)
              }}
            >
              {page.name}
            </button>
          ))}
          <button
            type="button"
            className="ctx-menu-item mt-1 w-full border-t border-nb-border"
            onClick={() => setOpen(false)}
          >
            Cancel
          </button>
        </dialog>
      )}
    </CellPageMoveContext.Provider>
  )
}
