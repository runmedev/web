import { useRef, useState, type ReactElement } from 'react'
import { ContextMenu } from '@radix-ui/themes'
import { useNotebookContext } from '../../contexts/NotebookContext'
import { notebookPages, pageNameKey } from '../../lib/notebookPages'
import { NotebookPageMenuItems } from '../NotebookPageMenuItems'

/** Opening the menu targets this tab's page, independently of the selected tab. */
export function NotebookPageTabMenu({
  notebookUri,
  pageId,
  readOnly,
  children,
  closeTabs,
  hasTabsToRight,
}: {
  notebookUri: string
  pageId: string
  readOnly: boolean
  closeTabs: (right: boolean) => void
  hasTabsToRight: boolean
  children: ReactElement
}) {
  const { useNotebookSnapshot, getNotebookData } = useNotebookContext()
  const snapshot = useNotebookSnapshot(notebookUri)
  const data = getNotebookData(notebookUri)
  const pages = notebookPages(snapshot?.notebook.metadata ?? {})
  const page = pages.find((p) => p.id === pageId)
  const [name, setName] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  if (
    !data ||
    !snapshot?.loaded ||
    readOnly ||
    snapshot.readOnly ||
    snapshot.releasePending ||
    snapshot.reviewPending ||
    !page
  )
    return children
  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger>{children}</ContextMenu.Trigger>
        <ContextMenu.Content
          size="1"
          onCloseAutoFocus={(event) => {
            if (input.current) {
              event.preventDefault()
              input.current.focus()
            }
          }}
        >
          <ContextMenu.Item onSelect={() => closeTabs(false)}>
            Close All Tabs
          </ContextMenu.Item>
          <ContextMenu.Item
            disabled={!hasTabsToRight}
            onSelect={() => closeTabs(true)}
          >
            Close All Tabs to the Right
          </ContextMenu.Item>
          <ContextMenu.Separator />
          <NotebookPageMenuItems
            contextMenu
            pages={pages}
            id={pageId}
            data={data}
            rename={() => setName(page.name)}
          />
        </ContextMenu.Content>
      </ContextMenu.Root>
      {name !== null && (
        <form
          className="flex items-center gap-1 text-sm"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim()) return
            data.setMetadataProperty(pageNameKey(pageId), name.trim())
            setName(null)
          }}
        >
          <input
            ref={input}
            autoFocus
            aria-label="Page name"
            className="w-32 rounded border border-nb-border px-2 py-1"
            value={name}
            onFocus={(e) => e.target.select()}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setName(null)
            }}
          />
          <button disabled={!name.trim()}>Save</button>
          <button type="button" onClick={() => setName(null)}>
            Cancel
          </button>
        </form>
      )}
    </>
  )
}
