import { useCallback, useEffect, useMemo, useState } from 'react'

import { LinkIcon } from '@heroicons/react/20/solid'
import { useCurrentDoc } from '../../contexts/CurrentDocContext'
import { useNotebookContext } from '../../contexts/NotebookContext'
import { useNotebookStore } from '../../contexts/NotebookStoreContext'
import { appLogger } from '../../lib/logging/runtime'
import {
  extractNotebookOutline,
  type NotebookOutlineEntry,
} from '../../lib/notebookOutline'
import { copyNotebookCellShareUrl } from '../../lib/shareLinks'
import { showToast } from '../../lib/toast'
import { useWorkspaceDocumentContext } from '../../contexts/WorkspaceDocumentContext'
import { NotebookPageTree } from './NotebookPageTree'
import { CELL_PAGE, notebookPages, resolvePage } from '../../lib/notebookPages'
import {
  notebookPageUri,
  parseNotebookPageUri,
  isNotebookDocumentUri,
} from '../../lib/workspaceDocuments/workspaceDocumentTypes'

function findCellElement(
  notebookUri: string,
  cellRefId: string
): HTMLElement | null {
  const notebookElements =
    document.querySelectorAll<HTMLElement>('[data-document-id]')
  const notebookElement = Array.from(notebookElements).find(
    (element) =>
      element.dataset.documentId === notebookUri &&
      !element.closest('[role="tabpanel"][data-state="inactive"]')
  )
  const elements =
    notebookElement?.querySelectorAll<HTMLElement>('[data-cell-ref-id]') ?? []
  return (
    Array.from(elements).find(
      (element) => element.dataset.cellRefId === cellRefId
    ) ?? null
  )
}

function focusCellElement(cellElement: HTMLElement): void {
  const focusTarget =
    cellElement.querySelector<HTMLElement>(
      '[data-cell-focus-role="rendered"]'
    ) ??
    cellElement.querySelector<HTMLElement>(
      '[data-cell-focus-role="editor"] textarea'
    ) ??
    cellElement.querySelector<HTMLElement>('[contenteditable="true"]') ??
    cellElement.querySelector<HTMLElement>('[data-cell-focus-role="editor"]') ??
    cellElement
  focusTarget.focus({ preventScroll: true })
}

export default function NotebookOutlinePanel() {
  const { getCurrentDoc, setCurrentDoc } = useCurrentDoc()
  const { useNotebookSnapshot, getNotebookData, useNotebookList } =
    useNotebookContext()
  const { store } = useNotebookStore()
  const currentDocUri = getCurrentDoc()
  const { showDocument } = useWorkspaceDocumentContext()
  const view = parseNotebookPageUri(currentDocUri ?? '')
  const notebookUri =
    view?.notebookUri ??
    (currentDocUri && isNotebookDocumentUri(currentDocUri) ? currentDocUri : '')
  const notebookSnapshot = useNotebookSnapshot(notebookUri)
  const entry = useNotebookList().find((n) => n.uri === notebookUri)
  const metadata = notebookSnapshot?.notebook.metadata
  const pages = useMemo(() => notebookPages(metadata ?? {}), [metadata])
  const current = resolvePage(view?.pageId, pages)
  const data =
    entry?.readOnly ||
    entry?.releasePending ||
    notebookSnapshot?.readOnly ||
    notebookSnapshot?.reviewPending ||
    notebookSnapshot?.releasePending
      ? null
      : getNotebookData(notebookUri)
  function openPage(id: string, name: string) {
    const uri = id ? notebookPageUri(notebookUri, id) : notebookUri
    if (id) showDocument(uri, { title: name, afterUri: notebookUri })
    setCurrentDoc(uri)
  }
  const [shareTarget, setShareTarget] = useState<{
    notebookUri: string
    targetUri: string | null
  }>(() => ({
    notebookUri,
    targetUri: notebookUri || null,
  }))
  const shareTargetUri =
    shareTarget.notebookUri === notebookUri ? shareTarget.targetUri : null
  const entriesByPage = useMemo(() => {
    const result = new Map<string | undefined, NotebookOutlineEntry[]>()
    for (const cell of notebookSnapshot?.notebook.cells ?? []) {
      const id = resolvePage(cell.metadata[CELL_PAGE], pages)
      const entries = result.get(id) ?? []
      entries.push(...extractNotebookOutline([cell]))
      result.set(id, entries)
    }
    return result
  }, [notebookSnapshot, pages])

  useEffect(() => {
    const fallbackUri = notebookUri || null
    if (!store || !notebookUri.startsWith('local://')) {
      setShareTarget({ notebookUri, targetUri: fallbackUri })
      return
    }

    let cancelled = false
    setShareTarget({ notebookUri, targetUri: null })
    void (async () => {
      try {
        const metadata = await store.getMetadata(notebookUri)
        if (!cancelled) {
          setShareTarget({
            notebookUri,
            targetUri: metadata?.remoteUri?.trim() || fallbackUri,
          })
        }
      } catch {
        if (!cancelled) {
          setShareTarget({ notebookUri, targetUri: fallbackUri })
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [notebookUri, store])

  const navigateToEntry = useCallback(
    (entry: NotebookOutlineEntry) => {
      const cellElement = findCellElement(notebookUri, entry.cellRefId)
      cellElement?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
      if (cellElement) {
        focusCellElement(cellElement)
      }
    },
    [notebookUri]
  )

  const copyEntryLink = useCallback(
    async (entry: NotebookOutlineEntry) => {
      if (!shareTargetUri) {
        return
      }
      try {
        await copyNotebookCellShareUrl(shareTargetUri, entry.cellRefId)
        showToast({ message: 'Link to cell copied', tone: 'success' })
      } catch (error) {
        appLogger.error('Failed to copy notebook cell link from outline', {
          attrs: {
            scope: 'notebook.share',
            code: 'NOTEBOOK_OUTLINE_CELL_LINK_COPY_FAILED',
            notebookUri: shareTargetUri,
            cellRefId: entry.cellRefId,
            error: String(error),
          },
        })
        showToast({
          message:
            'Could not copy the cell link. Check clipboard permissions and try again.',
          tone: 'error',
        })
      }
    },
    [shareTargetUri]
  )

  let emptyMessage: string | null = null
  if (!notebookUri) {
    emptyMessage = 'Open a notebook to see its outline.'
  } else if (!notebookSnapshot?.loaded) {
    emptyMessage = 'Loading outline…'
  }

  return (
    <div
      id="notebook-outline-panel"
      className="flex h-full min-h-0 w-full flex-col bg-nb-surface"
    >
      {emptyMessage ? (
        <p className="p-3 text-sm text-nb-text-muted">{emptyMessage}</p>
      ) : (
        <NotebookPageTree
          key={notebookUri}
          pages={pages}
          current={current}
          data={data}
          open={openPage}
          headings={(id) => (
            <ul className="space-y-0.5">
              {(entriesByPage.get(id) ?? []).map((entry) => (
                <li
                  key={`${entry.cellRefId}:${entry.line}`}
                  className="group flex min-w-0 items-center gap-1"
                >
                  <button
                    type="button"
                    className="block min-w-0 flex-1 truncate rounded-nb-sm py-1.5 pr-2 text-left text-sm text-nb-text-muted transition-colors hover:bg-white/80 hover:text-nb-text focus-visible:bg-white focus-visible:text-nb-text"
                    data-heading-level={entry.level}
                    onClick={() => {
                      if (id) openPage(id, pages.find((p) => p.id === id)!.name)
                      requestAnimationFrame(() => navigateToEntry(entry))
                    }}
                    style={{ paddingLeft: `${8 + (entry.level - 1) * 12}px` }}
                    title={entry.text}
                  >
                    {entry.text}
                  </button>
                  <button
                    type="button"
                    aria-label={`Copy link to ${entry.text}`}
                    className="icon-btn h-7 w-7 shrink-0 text-nb-text-faint transition-colors hover:bg-white/80 hover:text-nb-accent focus-visible:bg-white focus-visible:text-nb-accent disabled:opacity-40"
                    disabled={!shareTargetUri}
                    onClick={() => void copyEntryLink(entry)}
                    title="Copy link to cell"
                  >
                    <LinkIcon className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        />
      )}
    </div>
  )
}
