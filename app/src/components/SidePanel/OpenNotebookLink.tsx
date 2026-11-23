import { LinkIcon } from '@heroicons/react/24/outline'
import { Button, Dialog, TextField } from '@radix-ui/themes'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { driveLinkCoordinator } from '../../lib/driveLinkCoordinator'
import { getNotebookDataController } from '../../lib/notebookDataController'
import { appState } from '../../lib/runtime/AppState'
import { normalizeNotebookReferenceUri } from '../../lib/shareLinks'
import {
  driveFileUrl,
  isDriveItemUri,
  parseDriveItem,
} from '../../storage/drive'
import { NotebookStoreItemType } from '../../storage/notebook'

import {
  explorerNotebookBatches,
  matchExplorerNotebooks,
  type ExplorerNotebook,
} from '../../lib/explorerNotebookSearch'

async function openLink(text: string) {
  const uri = normalizeNotebookReferenceUri(text)
  if (uri.startsWith('local://file/') || uri.startsWith('fs://')) {
    await appState.openNotebook(uri)
    return
  }
  if (isDriveItemUri(uri)) {
    const item = parseDriveItem(uri)
    if (item.type === NotebookStoreItemType.File) {
      const remoteUri = driveFileUrl(item.id, item.resourceKey)
      // Folder sync can create a mirror before shared-link review. Only skip
      // the coordinator when we can focus a tab that is already open.
      const openTabs = getNotebookDataController().getOpenNotebooks()
      const store = appState.localNotebooks
      if (openTabs.length && store) {
        const mirror = await store.files
          .where('remoteId')
          .anyOf([remoteUri, driveFileUrl(item.id)])
          .first()
        const existing = openTabs.find((tab) => tab.uri === mirror?.id)
        if (existing) {
          await appState.focusNotebook(existing.uri)
          return
        }
      }
      await driveLinkCoordinator.enqueue(remoteUri)
      return
    }
  }
  throw new Error(
    'Enter a Runme notebook link, a Drive file link, or a local notebook URI.'
  )
}

/** Use the same parser as the opener so punctuation in a notebook name
 * (for example "[ops] errors") doesn't accidentally disable search.
 */
function isPastedNotebookLink(text: string): boolean {
  try {
    return /^[a-z][a-z\d+.-]*:\/\//i.test(normalizeNotebookReferenceUri(text))
  } catch {
    // Malformed percent escapes belong in the link validation path.
    return true
  }
}

function LinkForm({ onOpen }: { onOpen: () => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [notebooks, setNotebooks] = useState<ExplorerNotebook[]>([])
  const [loaded, setLoaded] = useState(false)
  const [incomplete, setIncomplete] = useState(false)
  const [selectedUri, setSelectedUri] = useState('')
  const listId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const query = text.trim()
  const searching = query.length > 0 && !isPastedNotebookLink(query)
  const [started, setStarted] = useState(false)
  useEffect(() => {
    if (searching) setStarted(true)
  }, [searching])
  useEffect(() => {
    if (!started) return
    const controller = new AbortController()
    void (async () => {
      for await (const { batch, incomplete } of explorerNotebookBatches(
        controller.signal
      )) {
        if (controller.signal.aborted) return
        if (batch.length) setNotebooks((previous) => [...previous, ...batch])
        setIncomplete(incomplete)
      }
      if (!controller.signal.aborted) setLoaded(true)
    })()
    return () => controller.abort()
  }, [started])
  const matches = useMemo(
    () => matchExplorerNotebooks(notebooks, searching ? query : ''),
    [notebooks, query, searching]
  )
  const index = Math.max(
    0,
    matches.findIndex((item) => item.uri === selectedUri)
  )
  const selected = matches[index]
  useEffect(() => {
    if (selectedUri)
      document
        .getElementById(listId + '-' + index)
        ?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedUri, index, listId])

  async function open(uri?: string) {
    if (busy || (!uri && searching)) return
    setBusy(true)
    try {
      if (uri) await appState.openNotebook(uri)
      else await openLink(text)
      if (formRef.current?.isConnected) onOpen()
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not open the notebook.'
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault()
        void open(selected?.uri)
      }}
    >
      <div className="flex gap-2">
        <TextField.Root
          className="flex-1"
          role="combobox"
          aria-label="Notebook name or link"
          aria-autocomplete="list"
          aria-expanded={!!selected}
          aria-controls={listId}
          aria-activedescendant={selected ? listId + '-' + index : undefined}
          placeholder="Search by name or paste a link"
          readOnly={busy}
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setSelectedUri('')
            setError('')
          }}
          onKeyDown={(event) => {
            if (
              !selected ||
              busy ||
              (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')
            )
              return
            event.preventDefault()
            const next =
              (index + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) %
              matches.length
            setSelectedUri(matches[next].uri)
          }}
        />
        <Button
          type="submit"
          disabled={busy || !query || (searching && !selected)}
        >
          {busy ? 'Opening…' : 'Open'}
        </Button>
      </div>
      <ul
        id={listId}
        role="listbox"
        aria-label="Matching notebooks"
        hidden={!selected}
        className="mt-2 max-h-64 overflow-auto"
      >
        {matches.map((item, i) => (
          <li
            key={item.uri}
            id={listId + '-' + i}
            role="option"
            aria-selected={index === i}
            className={
              'cursor-pointer rounded px-2 py-1 hover:bg-nb-accent-soft ' +
              (i === index ? 'bg-nb-accent-soft' : '')
            }
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void open(item.uri)}
          >
            <div className="truncate text-sm">{item.name}</div>
            <div className="truncate text-xs text-nb-text-muted">
              {item.folder}
            </div>
          </li>
        ))}
      </ul>
      {searching && !selected && (
        <p role="status" className="mt-2 text-sm text-nb-text-muted">
          {loaded ? 'No matching notebooks.' : 'Searching Explorer…'}
        </p>
      )}
      {searching && loaded && incomplete && (
        <p className="mt-2 text-sm text-nb-text-muted">
          Some Explorer folders could not be searched.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </form>
  )
}

export default function OpenNotebookLink() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'o'
      ) {
        event.preventDefault()
        event.stopPropagation()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <button
          type="button"
          aria-label="Open notebook"
          aria-keyshortcuts="Meta+O Control+O"
          className="group side-btn side-btn-inactive"
        >
          <LinkIcon className="h-5 w-5" aria-hidden="true" />
          <span className="side-tooltip">Open notebook (⌘O / Ctrl+O)</span>
        </button>
      </Dialog.Trigger>
      <Dialog.Content
        maxWidth="480px"
        align="center"
        aria-describedby={undefined}
      >
        <Dialog.Title>Open notebook</Dialog.Title>
        <LinkForm onOpen={() => setOpen(false)} />
      </Dialog.Content>
    </Dialog.Root>
  )
}
