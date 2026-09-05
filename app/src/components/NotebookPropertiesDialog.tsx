import { useEffect, useState } from 'react'
import { Button, Dialog } from '@radix-ui/themes'
import { useNotebookContext } from '../contexts/NotebookContext'
import { useNotebookStore } from '../contexts/NotebookStoreContext'
import { AUTO_IPYNB_KEY } from '../lib/derivedNotebook'
import { detectNotebookFileFormat } from '../lib/notebookFormat'

/** Properties edit the shared model; export status is separate from source saves. */
export function NotebookPropertiesDialog({
  uri,
  onClose,
}: {
  uri: string
  onClose: () => void
}) {
  const { useNotebookSnapshot, getNotebookData } = useNotebookContext()
  const snapshot = useNotebookSnapshot(uri)
  const { store } = useNotebookStore()
  const [status, setStatus] = useState<{
    uri?: string
    error?: string
    exportedAt?: string
  }>({})
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let active = true
    const refresh = () => {
      void store
        ?.getIpynbExportState(uri)
        .then((next) => {
          if (active) setStatus(next)
        })
        .catch((err) => {
          if (active) setError(String(err))
        })
    }
    refresh()
    const unsubscribe = store?.subscribeSync(uri, refresh)
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [store, uri])
  const enabled = snapshot?.notebook.metadata[AUTO_IPYNB_KEY] === 'true'
  const canConfigure =
    detectNotebookFileFormat(snapshot?.name ?? '') === 'runme-operation-log'
  const update = async (value: boolean) => {
    setSaving(true)
    setError('')
    try {
      const model = getNotebookData(uri)
      if (!model || !snapshot?.loaded)
        throw new Error('Wait for the notebook to load.')
      model.setMetadataProperty(AUTO_IPYNB_KEY, String(value))
      await model.flushPendingPersist()
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Content maxWidth="520px">
        <Dialog.Title>Notebook properties</Dialog.Title>
        <Dialog.Description size="2">
          {snapshot?.name ?? 'Notebook'}
        </Dialog.Description>
        <div id="notebook-export-properties" className="my-4 space-y-3 text-sm">
          {canConfigure ? (
            <>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={!snapshot?.loaded || snapshot.readOnly || saving}
                  onChange={(event) => void update(event.target.checked)}
                />
                Automatically save a Colab copy (.ipynb)
              </label>
              <p className="text-nb-text-muted">
                Creates a generated copy next to this notebook in Google Drive.
                Changes and outputs are exported in the background after saving.
                For local notebooks, export starts once linked to Drive.
              </p>
              <p className="text-nb-text-muted">
                Turning this off keeps the last copy and stops updating it.
              </p>
              {status.uri && (
                <a
                  href={status.uri
                    .replace(
                      'https://drive.google.com/file/d/',
                      'https://colab.research.google.com/drive/'
                    )
                    .replace(/\/view$/, '')}
                  target="_blank"
                  rel="noreferrer"
                  className="text-nb-accent underline"
                >
                  Open Colab copy
                </a>
              )}
              {enabled && status.error && (
                <p role="alert">
                  Your notebook is saved, but the Colab copy could not be
                  updated: {status.error}. Export retries on the next save or
                  Drive sync.
                </p>
              )}
              {enabled && !status.uri && (
                <p className="text-nb-text-muted">
                  Waiting for the next background export and a Google Drive
                  connection.
                </p>
              )}
            </>
          ) : (
            <p>Automatic Colab copies are available for .runme notebooks.</p>
          )}
          {error && <p role="alert">Could not save properties: {error}</p>}
        </div>
        <Button onClick={onClose}>Done</Button>
      </Dialog.Content>
    </Dialog.Root>
  )
}
