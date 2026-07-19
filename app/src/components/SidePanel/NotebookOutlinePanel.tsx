import { useCallback, useMemo } from 'react'

import { useCurrentDoc } from '../../contexts/CurrentDocContext'
import { useNotebookContext } from '../../contexts/NotebookContext'
import {
  extractNotebookOutline,
  type NotebookOutlineEntry,
} from '../../lib/notebookOutline'
import { isNotebookDocumentUri } from '../../lib/workspaceDocuments/workspaceDocumentTypes'

function findCellElement(
  notebookUri: string,
  cellRefId: string
): HTMLElement | null {
  const notebookElements =
    document.querySelectorAll<HTMLElement>('[data-document-id]')
  const notebookElement = Array.from(notebookElements).find(
    (element) => element.dataset.documentId === notebookUri
  )
  const elements =
    notebookElement?.querySelectorAll<HTMLElement>('[data-cell-ref-id]') ?? []
  return (
    Array.from(elements).find(
      (element) => element.dataset.cellRefId === cellRefId
    ) ?? null
  )
}

export default function NotebookOutlinePanel() {
  const { getCurrentDoc } = useCurrentDoc()
  const { useNotebookSnapshot } = useNotebookContext()
  const currentDocUri = getCurrentDoc()
  const notebookUri =
    currentDocUri && isNotebookDocumentUri(currentDocUri) ? currentDocUri : ''
  const notebookSnapshot = useNotebookSnapshot(notebookUri)
  const entries = useMemo(
    () =>
      notebookSnapshot?.loaded
        ? extractNotebookOutline(notebookSnapshot.notebook.cells ?? [])
        : [],
    [notebookSnapshot]
  )

  const navigateToEntry = useCallback(
    (entry: NotebookOutlineEntry) => {
      findCellElement(notebookUri, entry.cellRefId)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
    },
    [notebookUri]
  )

  let emptyMessage: string | null = null
  if (!notebookUri) {
    emptyMessage = 'Open a notebook to see its outline.'
  } else if (!notebookSnapshot?.loaded) {
    emptyMessage = 'Loading outline…'
  } else if (entries.length === 0) {
    emptyMessage = 'Add Markdown headings to build an outline.'
  }

  return (
    <div
      id="notebook-outline-panel"
      className="flex h-full min-h-0 w-full flex-col bg-nb-surface"
    >
      <div
        id="notebook-outline-panel-header"
        className="border-b border-nb-border px-4 py-3"
      >
        <p className="text-xs font-semibold tracking-[0.18em] text-nb-text-faint uppercase">
          Outline
        </p>
        <p className="mt-1 text-sm text-nb-text-muted">
          {entries.length} {entries.length === 1 ? 'heading' : 'headings'}
        </p>
      </div>
      <nav
        aria-label="Notebook outline"
        className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
      >
        {emptyMessage ? (
          <div
            id="notebook-outline-empty"
            className="rounded-nb-sm border border-dashed border-nb-border bg-white/60 px-3 py-4 text-sm text-nb-text-muted"
          >
            {emptyMessage}
          </div>
        ) : (
          <ul className="space-y-0.5">
            {entries.map((entry) => (
              <li key={`${entry.cellRefId}:${entry.line}`}>
                <button
                  type="button"
                  className="block w-full truncate rounded-nb-sm py-1.5 pr-2 text-left text-sm text-nb-text-muted transition-colors hover:bg-white/80 hover:text-nb-text focus-visible:bg-white focus-visible:text-nb-text"
                  data-heading-level={entry.level}
                  onClick={() => navigateToEntry(entry)}
                  style={{ paddingLeft: `${8 + (entry.level - 1) * 12}px` }}
                  title={entry.text}
                >
                  {entry.text}
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
    </div>
  )
}
