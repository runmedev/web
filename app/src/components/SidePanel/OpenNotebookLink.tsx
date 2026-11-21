import { LinkIcon } from '@heroicons/react/24/outline'
import { Button, Dialog, TextField } from '@radix-ui/themes'
import { useEffect, useState } from 'react'
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
        const ids = await store.files
          .where('remoteId')
          .anyOf([remoteUri, driveFileUrl(item.id)])
          .primaryKeys()
        const existing = openTabs.find((tab) => ids.includes(tab.uri))
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

function LinkForm({ onOpen }: { onOpen: () => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault()
        if (busy) return
        const form = event.currentTarget
        setBusy(true)
        try {
          await openLink(text)
          if (form.isConnected) onOpen()
        } catch (err) {
          setError(
            err instanceof Error ? err.message : 'Could not open the notebook.'
          )
        } finally {
          setBusy(false)
        }
      }}
    >
      <div className="flex gap-2">
        <TextField.Root
          className="flex-1"
          aria-label="Notebook link"
          placeholder="Paste a notebook link"
          readOnly={busy}
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setError('')
          }}
        />
        <Button type="submit" disabled={busy || !text.trim()}>
          {busy ? 'Opening…' : 'Open'}
        </Button>
      </div>
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
          aria-label="Open notebook link"
          aria-keyshortcuts="Meta+O Control+O"
          className="group side-btn side-btn-inactive"
        >
          <LinkIcon className="h-5 w-5" aria-hidden="true" />
          <span className="side-tooltip">Open notebook link (⌘O / Ctrl+O)</span>
        </button>
      </Dialog.Trigger>
      <Dialog.Content
        maxWidth="480px"
        align="center"
        aria-describedby={undefined}
      >
        <Dialog.Title>Open notebook link</Dialog.Title>
        <LinkForm onOpen={() => setOpen(false)} />
      </Dialog.Content>
    </Dialog.Root>
  )
}
