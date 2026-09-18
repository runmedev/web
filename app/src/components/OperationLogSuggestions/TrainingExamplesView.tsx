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
import { getCellTitle } from '../../lib/cellContent'
import { extractNotebookOutline } from '../../lib/notebookOutline'
import type { TrainingExample } from '../../lib/trainingExamples/model'
import type { ExampleSelection } from '../../lib/trainingExamples/registry'
import type LocalNotebooks from '../../storage/local'
import { parser_pb } from '../../runme/client'
import { ChangedCell } from './OperationLogSuggestionView'

const button =
  'rounded border border-nb-border px-2 py-1 text-sm disabled:opacity-40'

type CellOption = { key: string; source: string; cellId: string; label: string }
const sourceKey = (example: TrainingExample) =>
  JSON.stringify(example.provenance.source)

/** Capture document order/titles on load or explicit refresh, not each render.
 * Source-qualified keys keep identical cell IDs in different notebooks separate.
 * Deleted/unavailable cells remain selectable after the cells in the document.
 */
async function loadCellOptions(
  examples: TrainingExample[],
  selection: ExampleSelection | undefined,
  docUri: string,
  store: LocalNotebooks
): Promise<CellOption[]> {
  const sources = new Map<string, TrainingExample[]>()
  for (const example of examples) {
    const key = sourceKey(example)
    if (!sources.has(key)) sources.set(key, [])
    sources.get(key)!.push(example)
  }
  return (
    await Promise.all(
      [...sources].map(async ([source, group]) => {
        const ids = new Set(
          group.flatMap((example) => example.provenance.cellIds)
        )
        const job = selection?.jobs[group[0].id]
        const uri = job?.localUri ?? (!selection ? docUri : undefined)
        let cells: parser_pb.Cell[] = []
        if (uri) {
          const snapshot = getNotebookDataController()
            .getNotebookData(uri)
            ?.getSnapshot()
          try {
            cells = snapshot?.loaded
              ? snapshot.notebook.cells
              : (await store.loadOperationLogSnapshot(uri)).cells
          } catch {
            // Optional navigation metadata must not prevent self-contained previews.
          }
        }
        const prefix = sources.size > 1 ? `${job?.name ?? source} · ` : ''
        const option = (cellId: string, label: string): CellOption => ({
          key: JSON.stringify([source, cellId]),
          source,
          cellId,
          label: prefix + label,
        })
        const result: CellOption[] = []
        cells.forEach((cell, index) => {
          if (!ids.delete(cell.refId)) return
          const title =
            extractNotebookOutline([cell])[0]?.text ?? getCellTitle(cell.value)
          result.push(
            option(
              cell.refId,
              `Cell ${index + 1} · ${title.length > 80 ? title.slice(0, 77) + '…' : title}`
            )
          )
        })
        for (const id of ids)
          result.push(option(id, `Unavailable cell · ${id}`))
        return result
      })
    )
  ).flat()
}

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
  const [cellOptions, setCellOptions] = useState<CellOption[]>([])
  const view = useRef<HTMLDivElement>(null)
  const changedCell = useRef<HTMLElement>(null)
  const notebookKey = sourceKey
  const notebookExamples =
    index?.examples.filter(
      (e) => !notebookFilter || notebookKey(e) === notebookFilter
    ) ?? []
  const cellOption = cellOptions.find((option) => option.key === cellFilter)
  const filtered = notebookExamples.filter(
    (e) =>
      !cellOption ||
      (sourceKey(e) === cellOption.source &&
        e.provenance.cellIds.includes(cellOption.cellId))
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
  const focusedRow = preview?.diff.cells.find(
    (row) => row.kind !== 'unchanged' || row.moved
  )

  // Wait for the selected preview to mount before scrolling. Only the diff pane
  // moves; keep keyboard focus in the selector/navigation control being used.
  useEffect(() => {
    const container = view.current
    const target = changedCell.current
    if (!preview || !container) return
    const top = target
      ? container.scrollTop +
        target.getBoundingClientRect().top -
        container.getBoundingClientRect().top -
        12
      : 0
    container.scrollTo?.({ top: Math.max(0, top), behavior: 'instant' })
  }, [preview])

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
    setCellOptions([])
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
      const options = await loadCellOptions(
        result.examples,
        selection,
        docUri,
        store
      )
      if (!active) return
      setCellOptions(options)
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
                  {cellOptions
                    .filter(
                      (option) =>
                        !notebookFilter || option.source === notebookFilter
                    )
                    .map((option) => (
                      <option key={option.key} value={option.key}>
                        {option.label}
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
                <section
                  key={row.id}
                  ref={row.id === focusedRow?.id ? changedCell : undefined}
                  aria-label={`${row.kind} cell`}
                  data-example-focus={row.id === focusedRow?.id || undefined}
                >
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
