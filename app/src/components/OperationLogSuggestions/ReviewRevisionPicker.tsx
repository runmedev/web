import { useEffect, useState } from 'react'
import { ReviewScopePicker } from './ReviewScopePicker'
import {
  revisionFollows,
  revisionLabel,
  type NotebookRevision,
} from '../../lib/operationLog/revisions'
import type LocalNotebooks from '../../storage/local'

export type ReviewPreview = Awaited<
  ReturnType<LocalNotebooks['previewNotebookReview']>
>

/** Preview is read-only. Cleanup prevents slow responses replacing newer choices. */
export function ReviewRevisionPicker({
  revisions,
  store,
  docUri,
  disabled,
  onPreview,
  onStart,
  onLabel,
}: {
  revisions: NotebookRevision[]
  store: LocalNotebooks
  docUri: string
  disabled: boolean
  onPreview: (preview: ReviewPreview | undefined) => void
  onStart: (preview: ReviewPreview) => void
  onLabel: (
    revisionId: string,
    name: string,
    description: string
  ) => Promise<boolean>
}) {
  const [startId, setStartId] = useState('empty')
  const [endId, setEndId] = useState(revisions.at(-1)?.id ?? '')
  const [namedOnly, setNamedOnly] = useState(false)
  const [preview, setPreview] = useState<ReviewPreview>()
  const [fullPreview, setFullPreview] = useState<ReviewPreview>()
  const [loading, setLoading] = useState(false)
  const [scope, setScope] = useState<{ pair: string; cellIds?: string[] }>()
  const [error, setError] = useState('')
  const [labelId, setLabelId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const choices = revisions.filter(
    (r) => !namedOnly || r.name || r.id === 'empty'
  )
  const start = choices.find((r) => r.id === startId) ?? choices[0]
  const ends = start ? choices.filter((r) => revisionFollows(start, r)) : []
  const end = ends.find((r) => r.id === endId) ?? ends.at(-1)
  const pair = JSON.stringify([start?.id, end?.id])
  const cellIds = scope?.pair === pair ? scope.cellIds : undefined
  const currentFullPreview =
    fullPreview?.start.id === start?.id && fullPreview?.end.id === end?.id
      ? fullPreview
      : undefined
  useEffect(() => {
    let cancelled = false
    setPreview(undefined)
    onPreview(undefined)
    setError('')
    setLoading(true)
    if (!start || !end) return
    setStartId(start.id)
    setEndId(end.id)
    void store
      .previewNotebookReview(docUri, {
        startRevisionId: start.id,
        endRevisionId: end.id,
      })
      .then((next) => {
        if (!cancelled) {
          setFullPreview(next)
          setLoading(false)
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e))
          setLoading(false)
          setFullPreview(undefined)
        }
      })
    return () => {
      cancelled = true
    }
  }, [docUri, store, start?.id, end?.id, onPreview, namedOnly, revisions])
  // Scope changes are read-only previews. Ignore stale asynchronous responses,
  // and never let an old whole-document result enable Start for a new scope.
  useEffect(() => {
    let cancelled = false
    setPreview(undefined)
    onPreview(undefined)
    if (loading || !currentFullPreview) return
    if (cellIds?.length === 0) {
      setError('Choose a section containing at least one cell')
      return
    }
    setError('')
    const publish = (next: ReviewPreview) => {
      if (!cancelled) {
        setPreview(next)
        onPreview(next)
      }
    }
    if (cellIds === undefined) publish(currentFullPreview)
    else
      void store
        .previewNotebookReview(docUri, {
          startRevisionId: currentFullPreview.start.id,
          endRevisionId: currentFullPreview.end.id,
          cellIds,
        })
        .then(publish)
        .catch((e) => {
          if (!cancelled) setError(String(e))
        })
    return () => {
      cancelled = true
    }
  }, [currentFullPreview, cellIds, loading, docUri, store, onPreview])
  const selectionChanged = () => {
    setPreview(undefined)
    onPreview(undefined)
  }
  return (
    <section aria-label="Choose review revisions" className="space-y-3 py-3">
      <label className="block text-sm">
        <input
          type="checkbox"
          checked={namedOnly}
          onChange={(e) => {
            selectionChanged()
            setNamedOnly(e.target.checked)
          }}
        />{' '}
        Named revisions only
      </label>
      <label className="block text-sm">
        Start revision
        <select
          aria-label="Start revision"
          className="mt-1 w-full rounded border p-2"
          disabled={disabled}
          value={start?.id ?? ''}
          onChange={(e) => {
            if (e.target.value === start?.id) return
            selectionChanged()
            setStartId(e.target.value)
          }}
        >
          {choices.map((r) => (
            <option key={r.id} value={r.id}>
              {revisionLabel(r)}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        End revision
        <select
          aria-label="End revision"
          className="mt-1 w-full rounded border p-2"
          disabled={disabled || !ends.length}
          value={end?.id ?? ''}
          onChange={(e) => {
            if (e.target.value === end?.id) return
            selectionChanged()
            setEndId(e.target.value)
          }}
        >
          {!ends.length && <option value="">No later revisions</option>}
          {ends.map((r) => (
            <option key={r.id} value={r.id}>
              {revisionLabel(r)}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-nb-text-muted">
        Preview changes as you select. Starting a review fixes both revisions
        and the selected cells.
      </p>
      {currentFullPreview && (
        <ReviewScopePicker
          key={pair}
          before={currentFullPreview.before}
          after={currentFullPreview.after}
          disabled={disabled || loading}
          onChange={(cellIds) => {
            selectionChanged()
            setScope({ pair, cellIds })
          }}
        />
      )}
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
      <button
        className="rounded border px-2 py-1 text-sm disabled:opacity-40"
        disabled={disabled || !preview}
        onClick={() => {
          if (preview) onStart(preview)
        }}
      >
        {preview?.existingReviewId ? 'Continue review' : 'Start review'}
      </button>
      <details className="border-t pt-2">
        <summary className="cursor-pointer text-sm">Name a revision</summary>
        <label className="block text-sm">
          Revision to name
          <select
            aria-label="Revision to name"
            className="my-1 w-full rounded border p-2"
            value={labelId}
            onChange={(e) => {
              setLabelId(e.target.value)
              const r = revisions.find((r) => r.id === e.target.value)
              setName(r?.name ?? '')
              setDescription(r?.description ?? '')
            }}
          >
            <option value="">Select a revision</option>
            {revisions.map((r) => (
              <option key={r.id} value={r.id}>
                {revisionLabel(r)}
              </option>
            ))}
          </select>
        </label>
        <input
          aria-label="Revision name"
          className="my-1 w-full rounded border p-2 text-sm"
          placeholder="Version"
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <textarea
          aria-label="Revision description"
          className="my-1 w-full rounded border p-2 text-sm"
          placeholder="Codex addressed comments"
          maxLength={2000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <button
          className="rounded border px-2 py-1 text-sm disabled:opacity-40"
          disabled={disabled || !labelId || !name.trim()}
          onClick={() => void onLabel(labelId, name, description)}
        >
          Save revision name
        </button>
      </details>
    </section>
  )
}
