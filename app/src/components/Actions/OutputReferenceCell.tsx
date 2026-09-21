import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { CodeBracketIcon } from '@heroicons/react/20/solid'

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
  children,
}: {
  cell: parser_pb.Cell
  store: LocalNotebooks | null
  uri: string
  readOnly: boolean
  onChange: (value: string) => void
  children?: ReactNode
}) {
  const [editing, setEditing] = useState(!cell.value.trim())
  const [draft, setDraft] = useState(cell.value)
  const [result, setResult] = useState<ResolvedOutputReference>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [showSource, setShowSource] = useState(false)
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
      className="relative min-w-0 rounded-nb-md focus-visible:outline focus-visible:outline-nb-accent"
      data-testid="output-reference-cell"
      tabIndex={readOnly ? -1 : 0}
      aria-label="Output reference"
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
        if (
          !editing &&
          event.key === 'Enter' &&
          event.target === event.currentTarget
        ) {
          event.preventDefault()
          enterEditMode()
        }
        if (editing && !readOnly && event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          setEditing(false)
        }
      }}
    >
      {editing && !readOnly ? (
        <>
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
          {children}
        </>
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
              <div className="space-y-2">
                {showSource && (
                  <div
                    id={`reference-source-${cell.refId}`}
                    className="rounded-nb-md border border-nb-border bg-nb-surface-2 p-3 text-sm"
                  >
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
                  </div>
                )}
                <div className="relative">
                  <ActionOutputItemView
                    item={result.item}
                    outputIndex={0}
                    itemIndex={0}
                    onDoubleClick={readOnly ? undefined : enterEditMode}
                  />
                  <button
                    type="button"
                    className="icon-btn absolute right-1 top-1 h-7 w-7 rounded bg-white/90 opacity-70 hover:opacity-100 focus-visible:opacity-100"
                    aria-label={
                      showSource ? 'Hide executed code' : 'View executed code'
                    }
                    title={
                      showSource ? 'Hide executed code' : 'View executed code'
                    }
                    aria-expanded={showSource}
                    aria-controls={`reference-source-${cell.refId}`}
                    onClick={() => setShowSource((value) => !value)}
                  >
                    <CodeBracketIcon className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
            )
          )}
        </>
      )}
    </div>
  )
}
