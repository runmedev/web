import { useCallback, useEffect, useState } from 'react'

import type LocalNotebooks from '../../storage/local'
import { parser_pb } from '../../runme/client'
import type { ResolvedOutputReference } from '../../lib/outputReference'
import { ActionOutputItemView } from './ActionOutputItems'

/** The editor owns source; resolved historical output is read-only derived state. */
export function OutputReferenceCell({
  cell,
  store,
  uri,
  readOnly,
  onChange,
}: {
  cell: parser_pb.Cell
  store: LocalNotebooks | null
  uri: string
  readOnly: boolean
  onChange: (value: string) => void
}) {
  const [editing, setEditing] = useState(!cell.value.trim())
  const [draft, setDraft] = useState(cell.value)
  const [result, setResult] = useState<ResolvedOutputReference>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  /** Editing changes presentation only; source keeps using the normal autosave path. */
  const enterEditMode = useCallback(() => {
    if (!readOnly) setEditing(true)
  }, [readOnly])
  useEffect(() => {
    setDraft(cell.value)
  }, [cell.value])
  useEffect(() => {
    let disposed = false
    let request = 0
    const refresh = async () => {
      const current = ++request
      setLoading(true)
      try {
        if (!store) throw new Error('Notebook storage is unavailable.')
        const resolved = await store.resolveOutputReference(uri, cell.value)
        if (!disposed && current === request) {
          setResult(resolved)
          setError('')
        }
      } catch (error) {
        if (!disposed && current === request) {
          setResult(undefined)
          setError(String(error))
        }
      } finally {
        if (!disposed && current === request) setLoading(false)
      }
    }
    void refresh()
    // A Drive merge may bring missing history. Never cache a failure forever.
    const unsubscribe = store?.subscribeSync(uri, () => void refresh())
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [store, uri, cell.value])

  return (
    <div
      id={`output-reference-${cell.refId}`}
      className="min-w-0 rounded-nb-md border border-nb-border p-3"
      data-testid="output-reference-cell"
      onDoubleClick={(event) => {
        // Preserve the behavior of links, buttons, and provenance controls.
        if (
          (event.target as HTMLElement).closest(
            'button, a, input, textarea, select, summary'
          )
        )
          return
        enterEditMode()
      }}
      onKeyDown={(event) => {
        if (editing && !readOnly && event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          setEditing(false)
        }
      }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs text-nb-text-muted">Output reference</span>
        {!readOnly && (
          <button
            className="nb-btn"
            type="button"
            onClick={() => {
              if (editing) onChange(draft)
              setEditing(!editing)
            }}
          >
            {editing ? 'Render reference' : 'Edit reference'}
          </button>
        )}
      </div>
      {editing && !readOnly ? (
        <textarea
          autoFocus
          aria-label="Output reference source"
          className="min-h-24 w-full resize-y rounded border border-nb-border bg-nb-surface p-2 font-mono text-sm"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            onChange(event.target.value)
          }}
          placeholder={
            '<a href="#cell=…&amp;version=operation%3A…&amp;output_item=0.0">Result</a>'
          }
        />
      ) : (
        <>
          {loading ? (
            <p role="status">Loading referenced output…</p>
          ) : error ? (
            <div role="alert">
              <p>Output reference unavailable: {error}</p>
              <pre className="whitespace-pre-wrap break-all text-xs">
                {cell.value}
              </pre>
            </div>
          ) : (
            result && (
              <>
                <ActionOutputItemView
                  item={result.item}
                  outputIndex={0}
                  itemIndex={0}
                  onDoubleClick={readOnly ? undefined : enterEditMode}
                />
                <details className="mt-2 text-sm">
                  <summary className="cursor-pointer">
                    View executed code
                  </summary>
                  <p className="break-all text-xs">
                    Execution {result.executionId} · {result.status}
                  </p>
                  {result.provenanceError ? (
                    <p role="status">{result.provenanceError}</p>
                  ) : (
                    <>
                      <p className="break-all text-xs">
                        Source version: {result.sourceOperationId} ·{' '}
                        {result.language}
                      </p>
                      <pre
                        aria-label="Executed code"
                        className="overflow-x-auto whitespace-pre-wrap rounded bg-nb-surface-2 p-3"
                      >
                        {result.source}
                      </pre>
                    </>
                  )}
                </details>
              </>
            )
          )}
        </>
      )}
    </div>
  )
}
