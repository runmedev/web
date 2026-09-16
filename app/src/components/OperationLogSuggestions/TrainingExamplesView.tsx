import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  getExampleSelection,
  subscribeExampleSelections,
} from '../../lib/trainingExamples/registry'
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/20/solid'

import {
  loadTrainingExamples,
  loadTrainingExamplePreview,
} from '../../lib/trainingExamples/client'
import type {
  ExampleIndex,
  ExamplePreview,
} from '../../lib/trainingExamples/protocol'
import { getNotebookDataController } from '../../lib/notebookDataController'
import type LocalNotebooks from '../../storage/local'
import { parser_pb } from '../../runme/client'
import { ChangedCell } from './OperationLogSuggestionView'

const button =
  'rounded border border-nb-border px-2 py-1 text-sm disabled:opacity-40'

/** Kind/language transitions can change meaning without changing source text. */
function contentType(cell?: parser_pb.Cell): string {
  if (!cell) return 'absent'
  return `${cell.kind === parser_pb.CellKind.CODE ? 'code' : 'markup'} / ${cell.languageId}`
}

/** Read-only dataset inspection. It intentionally has no accept/undo buttons:
 * changing a training label is not an edit to the source notebook's review.
 */
export function TrainingExamplesView({
  docUri,
  store,
}: {
  docUri: string
  store: LocalNotebooks
}) {
  const selection = useSyncExternalStore(subscribeExampleSelections, () =>
    getExampleSelection(docUri)
  )
  const [index, setIndex] = useState<ExampleIndex>()
  const [selectedId, setSelectedId] = useState('')
  const [loadedPreview, setPreview] = useState<{
    exampleId: string
    docUri: string
    value: ExamplePreview
  }>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [collapsed, setCollapsed] = useState(false)
  const [notebookFilter, setNotebookFilter] = useState('')
  const [cellFilter, setCellFilter] = useState('')
  const view = useRef<HTMLDivElement>(null)
  const notebookKey = (
    example: NonNullable<typeof index>['examples'][number]
  ) => JSON.stringify(example.provenance.source)
  const notebookExamples =
    index?.examples.filter(
      (e) => !notebookFilter || notebookKey(e) === notebookFilter
    ) ?? []
  const filtered = notebookExamples.filter(
    (e) => !cellFilter || e.provenance.cellIds.includes(cellFilter)
  )
  const selected =
    filtered.find((example) => example.id === selectedId) ?? filtered[0]
  const activeId = selected?.id
  // Guard in render, not only in the effect: selection must not paint even one
  // frame of the previous diff under the next example's label.
  const preview =
    loadedPreview &&
    loadedPreview.exampleId === activeId &&
    loadedPreview.docUri === docUri
      ? loadedPreview.value
      : undefined
  const position = filtered.findIndex((example) => example.id === activeId)

  useEffect(() => {
    setNotebookFilter('')
    setCellFilter('')
  }, [docUri, selection])

  // An explicit refresh freezes a new derived index. Do not move the user's
  // selection in response to background edits while they inspect an example.
  useEffect(() => {
    let active = true
    setLoading(true)
    setIndex(undefined)
    setPreview(undefined)
    setError('')
    void (async () => {
      await getNotebookDataController()
        .getNotebookData(docUri)
        ?.flushPendingPersist()
      const result = selection
        ? {
            examples: selection.examples,
            issues: [],
            sourceChecksum: '',
            ruleVersion: 'recipe',
          }
        : await loadTrainingExamples(await store.trainingExampleJob(docUri))
      if (!active) return
      setIndex(result)
      setSelectedId((old) =>
        result.examples.some((example) => example.id === old)
          ? old
          : (result.examples[0]?.id ?? '')
      )
    })()
      .catch((error) => {
        if (active) setError(String(error))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [docUri, store, refresh, selection])

  // Prevent a slow preview for A overwriting the newer selection B (or another
  // document). The label and diff are always published for the same example.
  useEffect(() => {
    let active = true
    setPreview(undefined)
    setPreviewLoading(Boolean(selected))
    if (selected) {
      setError('')
      void loadTrainingExamplePreview(selected)
        .then((result) => {
          if (active) {
            setPreview({ exampleId: selected.id, docUri, value: result })
            view.current?.scrollTo?.(0, 0)
          }
        })
        .catch((error) => {
          if (active) setError(String(error))
        })
        .finally(() => {
          if (active) setPreviewLoading(false)
        })
    }
    return () => {
      active = false
    }
  }, [docUri, store, selected, selection, refresh])

  return (
    <div
      id="training-examples-view"
      className="flex h-full min-h-0 min-w-0 bg-white text-nb-text"
    >
      <aside
        id="training-examples-controls"
        aria-label="Training examples"
        className={`shrink-0 overflow-y-auto border-r border-nb-border bg-nb-surface-1 p-3 ${collapsed ? 'w-12' : 'w-80 max-w-[40%]'}`}
      >
        <button
          className={button}
          aria-label={
            collapsed ? 'Expand examples panel' : 'Collapse examples panel'
          }
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? (
            <ChevronRightIcon className="h-4 w-4" />
          ) : (
            <ChevronLeftIcon className="h-4 w-4" />
          )}
        </button>
        <div
          id="training-examples-details"
          hidden={collapsed}
          className="mt-3 space-y-4"
        >
          <h2 className="font-semibold">Training examples</h2>
          <p className="text-xs text-nb-text-muted">
            {selection ? 'Recipe-selected examples. ' : ''}Computed in memory.
            No sidecar is written; exporting and uploading are separate actions.
          </p>
          <button
            className={button}
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            Refresh examples
          </button>
          {index && (
            <>
              <label className="block text-sm">
                Notebook
                <select
                  aria-label="Filter by notebook"
                  value={notebookFilter}
                  className="mt-1 w-full rounded border border-nb-border p-2"
                  onChange={(event) => {
                    setNotebookFilter(event.target.value)
                    setCellFilter('')
                  }}
                >
                  <option value="">All notebooks</option>
                  {[...new Set(index.examples.map(notebookKey))].map((key) => {
                    const example = index.examples.find(
                      (e) => notebookKey(e) === key
                    )!
                    const source = example.provenance.source
                    return (
                      <option key={key} value={key}>
                        {selection?.jobs[example.id]?.name ??
                          ('driveFileId' in source
                            ? source.driveFileId
                            : source.localUri)}
                      </option>
                    )
                  })}
                </select>
              </label>
              <label className="block text-sm">
                Cell
                <select
                  aria-label="Filter by cell"
                  value={cellFilter}
                  className="mt-1 w-full rounded border border-nb-border p-2"
                  onChange={(event) => setCellFilter(event.target.value)}
                >
                  <option value="">All cells</option>
                  {[
                    ...new Set(
                      notebookExamples.flatMap((e) => e.provenance.cellIds)
                    ),
                  ].map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                Example
                <select
                  aria-label="Example"
                  className="mt-1 w-full rounded border border-nb-border p-2"
                  disabled={!filtered.length}
                  value={activeId ?? ''}
                  onChange={(event) => setSelectedId(event.target.value)}
                >
                  {!filtered.length && <option value="">No examples</option>}
                  {filtered.map((example, i) => (
                    <option key={example.id} value={example.id}>
                      {i + 1} · {example.accepted ? 'Accepted' : 'Rejected'} ·{' '}
                      {example.provenance.labelSource}
                    </option>
                  ))}
                </select>
              </label>
              <div
                id="training-examples-navigation"
                className="flex items-center gap-2"
              >
                <button
                  className={button}
                  aria-label="Previous example"
                  disabled={position <= 0}
                  onClick={() => setSelectedId(filtered[position - 1].id)}
                >
                  ←
                </button>
                <span aria-live="polite">
                  {position < 0 ? 0 : position + 1} / {filtered.length}
                </span>
                <button
                  className={button}
                  aria-label="Next example"
                  disabled={position < 0 || position >= filtered.length - 1}
                  onClick={() => setSelectedId(filtered[position + 1].id)}
                >
                  →
                </button>
              </div>
              {selected && (
                <>
                  <p>
                    <span
                      className={`rounded px-2 py-1 font-semibold ${selected.accepted ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`}
                    >
                      {selected.accepted ? 'Accepted' : 'Rejected'}
                    </span>
                  </p>
                  <p className="text-sm">
                    Label source: {selected.provenance.labelSource}
                  </p>
                  <details className="text-xs">
                    <summary>Revision pair and evidence</summary>
                    <pre className="whitespace-pre-wrap break-all">
                      {JSON.stringify(selected, null, 2)}
                    </pre>
                  </details>
                </>
              )}
              {index.issues.length > 0 && (
                <details>
                  <summary>{index.issues.length} extraction warning(s)</summary>
                  <ul className="list-disc pl-4 text-sm">
                    {index.issues.map((issue, i) => (
                      <li key={i}>
                        {issue.reason} ({issue.recordIds.join(', ')})
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>
      </aside>
      <div
        id="training-examples-diff"
        ref={view}
        className="min-w-0 flex-1 overflow-auto p-4"
        aria-busy={loading || previewLoading}
      >
        {error && (
          <p role="alert" className="mb-4 text-red-700">
            {error}
          </p>
        )}
        {(loading || previewLoading) && (
          <p role="status">
            {loading ? 'Generating examples…' : 'Loading example diff…'}
          </p>
        )}
        {!loading && index?.examples.length === 0 && (
          <p>
            No eligible examples yet. Name a revision, comment on a cell
            version, or accept/undo a cell change, then refresh examples.
          </p>
        )}
        {preview && selected && (
          <>
            <h3 className="mb-3 font-semibold">
              Example {position + 1} ·{' '}
              {selected.accepted ? 'Accepted' : 'Rejected'}
            </h3>
            <p className="mb-4 text-xs text-nb-text-muted">
              Content-only endpoint diff. Comments, outputs and author metadata
              are excluded.
            </p>
            <div id="training-examples-diff-cells" className="space-y-3">
              {preview.diff.cells.map((row) => (
                <section key={row.id} aria-label={`${row.kind} cell`}>
                  {(row.moved ||
                    row.changedFields.includes('language') ||
                    row.changedFields.includes('kind')) && (
                    <p className="text-xs text-nb-text-muted">
                      {row.moved
                        ? `Moved from ${(row.baseIndex ?? 0) + 1} to ${(row.compareIndex ?? 0) + 1} · `
                        : ''}
                      {contentType(row.baseCell)} →{' '}
                      {contentType(row.compareCell)}
                    </p>
                  )}
                  <ChangedCell row={row} />
                </section>
              ))}
            </div>
            <details className="mt-4 text-xs">
              <summary>Classifier input</summary>
              <pre className="whitespace-pre-wrap break-all">
                {JSON.stringify(preview.input, null, 2)}
              </pre>
            </details>
          </>
        )}
      </div>
    </div>
  )
}
