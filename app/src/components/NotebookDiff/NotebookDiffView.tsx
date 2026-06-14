import { useEffect, useState } from 'react'

import { Badge, Button, ScrollArea, Text } from '@radix-ui/themes'

import { parser_pb } from '../../runme/client'
import { useNotebookStore } from '../../contexts/NotebookStoreContext'
import type {
  CellDiff,
  NotebookDiffDocument,
  OutputItemSummary,
  TextDiff,
  TextDiffLine,
} from '../../lib/notebookDiff/model'
import {
  openNotebookDriveRevisionDiff,
  refreshNotebookConflictDiff,
  restoreDeletedConflictCell,
} from '../../lib/notebookDiff/conflict'
import type { DriveRevision } from '../../storage/drive'
import { NotebookConflictChangedError } from '../../storage/local'
import { getNotebookDataController } from '../../lib/notebookDataController'
import { showToast } from '../../lib/toast'

function cellKindLabel(cell?: parser_pb.Cell): string {
  if (!cell) {
    return ''
  }
  if (cell.kind === parser_pb.CellKind.MARKUP) {
    return 'Markdown'
  }
  if (cell.kind === parser_pb.CellKind.CODE) {
    return cell.languageId || 'Code'
  }
  return cell.languageId || 'Cell'
}

function changeBadgeColor(
  kind: CellDiff['kind']
): 'gray' | 'green' | 'red' | 'amber' {
  switch (kind) {
    case 'inserted':
      return 'green'
    case 'deleted':
      return 'red'
    case 'modified':
      return 'amber'
    default:
      return 'gray'
  }
}

function statusText(row: CellDiff): string {
  if (row.kind === 'inserted') {
    return 'Inserted'
  }
  if (row.kind === 'deleted') {
    return 'Deleted'
  }
  if (row.kind === 'unchanged') {
    return row.moved ? 'Moved' : 'Unchanged'
  }
  return row.changedFields
    .map((field) => (field === 'move' ? 'moved' : field))
    .join(', ')
}

function lineClass(line: TextDiffLine, side: 'base' | 'compare'): string {
  if (line.kind === 'equal') {
    return 'text-nb-text'
  }
  if (side === 'base' && line.kind === 'removed') {
    return 'bg-red-50 text-red-900'
  }
  if (side === 'compare' && line.kind === 'added') {
    return 'bg-emerald-50 text-emerald-900'
  }
  return 'text-nb-text-faint'
}

function lineText(line: TextDiffLine, side: 'base' | 'compare'): string {
  if (side === 'base') {
    return line.baseLine ?? ''
  }
  return line.compareLine ?? ''
}

function SourceDiff({
  diff,
  side,
  fallback,
}: {
  diff?: TextDiff
  side: 'base' | 'compare'
  fallback: string
}) {
  const lines = diff?.lines.length
    ? diff.lines
    : fallback
      ? fallback.split(/\r?\n/)
      : []
  return (
    <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5">
      {lines.length === 0 ? (
        <span className="text-nb-text-faint">No source</span>
      ) : (
        lines.map((line, index) => {
          const normalizedLine =
            typeof line === 'string'
              ? ({
                  kind: 'equal',
                  baseLine: line,
                  compareLine: line,
                } as TextDiffLine)
              : line
          return (
            <div
              key={`${side}-line-${index}`}
              className={`min-h-5 rounded px-1 ${lineClass(normalizedLine, side)}`}
            >
              {lineText(normalizedLine, side) || ' '}
            </div>
          )
        })
      )}
    </pre>
  )
}

function OutputSummary({
  items,
  side,
}: {
  items: OutputItemSummary[]
  side: 'base' | 'compare'
}) {
  if (items.length === 0) {
    return <div className="text-xs text-nb-text-faint">No outputs</div>
  }
  return (
    <details
      className="rounded border border-nb-border bg-nb-surface-2 p-2 text-xs"
      open={false}
    >
      <summary className="cursor-pointer text-nb-text-muted">
        {items.length} output item{items.length === 1 ? '' : 's'} on {side}
      </summary>
      <div className="mt-2 space-y-2">
        {items.map((item, index) => (
          <div key={`${side}-output-${index}`} className="rounded bg-white p-2">
            <div className="font-mono text-[11px] text-nb-text-muted">
              {item.mime} · {item.kind} · {item.sizeBytes} bytes
            </div>
            {item.text && (
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-nb-text">
                {item.text}
              </pre>
            )}
          </div>
        ))}
      </div>
    </details>
  )
}

function CellPanel({ row, side }: { row: CellDiff; side: 'base' | 'compare' }) {
  const cell = side === 'base' ? row.baseCell : row.compareCell
  const empty =
    (side === 'base' && row.kind === 'inserted') ||
    (side === 'compare' && row.kind === 'deleted')
  const outputItems =
    side === 'base'
      ? (row.outputDiff?.baseItems ?? [])
      : (row.outputDiff?.compareItems ?? [])

  if (empty) {
    return (
      <div className="flex min-h-28 items-center justify-center rounded border border-dashed border-nb-border bg-nb-surface-2 text-sm text-nb-text-faint">
        No cell on this side
      </div>
    )
  }

  return (
    <div className="min-w-0 rounded border border-nb-border bg-white">
      <div className="flex items-center justify-between border-b border-nb-border bg-nb-surface-2 px-3 py-2">
        <span className="text-xs font-medium text-nb-text-muted">
          {cellKindLabel(cell)}
        </span>
        <span className="font-mono text-[11px] text-nb-text-faint">
          {cell?.refId || 'no-ref'}
        </span>
      </div>
      <SourceDiff
        diff={row.sourceDiff}
        side={side}
        fallback={cell?.value ?? ''}
      />
      {row.outputDiff?.changed && (
        <div className="border-t border-nb-border p-3">
          <OutputSummary items={outputItems} side={side} />
        </div>
      )}
    </div>
  )
}

function RestoreDeletedCellButton({
  localUri,
  row,
  onRestored,
}: {
  localUri: string
  row: CellDiff
  onRestored: (document: NotebookDiffDocument) => void
}) {
  const { store } = useNotebookStore()
  const [isRestoring, setIsRestoring] = useState(false)

  const restoreCell = async () => {
    if (!store) {
      return
    }
    setIsRestoring(true)
    try {
      const notebookData = getNotebookDataController().getNotebookData(localUri)
      await notebookData?.flushPendingPersist()
      const result = await restoreDeletedConflictCell(store, localUri, row, {
        localNotebook: notebookData?.getSnapshot().notebook,
      })
      notebookData?.loadNotebook(result.localNotebook, { persist: false })
      onRestored(result.document)
      showToast({
        message: 'Inserted upstream cell into the local notebook.',
        tone: 'success',
      })
    } catch {
      showToast({
        message: 'Unable to insert upstream cell. Please try again.',
        tone: 'error',
      })
    } finally {
      setIsRestoring(false)
    }
  }

  return (
    <Button
      type="button"
      size="1"
      color="red"
      variant="soft"
      disabled={!store || isRestoring}
      aria-label="Insert upstream cell into local notebook"
      title="Insert upstream cell into local notebook"
      onClick={() => {
        void restoreCell()
      }}
    >
      {isRestoring ? 'Inserting...' : 'Insert ->'}
    </Button>
  )
}

function revisionLabel(revision: DriveRevision): string {
  const modified = revision.modifiedTime
    ? new Date(revision.modifiedTime).toLocaleString()
    : 'Unknown time'
  const author =
    revision.lastModifyingUser?.displayName ||
    revision.lastModifyingUser?.emailAddress
  return author ? `${modified} by ${author}` : modified
}

function sortDriveRevisions(revisions: DriveRevision[]): DriveRevision[] {
  return [...revisions].sort((a, b) => {
    const aTime = a.modifiedTime ? Date.parse(a.modifiedTime) : 0
    const bTime = b.modifiedTime ? Date.parse(b.modifiedTime) : 0
    return bTime - aTime
  })
}

function DriveRevisionSelector({
  localUri,
  selectedRevisionId,
  resolutionKind,
  currentUpstreamRevisionId,
}: {
  localUri: string
  selectedRevisionId?: string
  resolutionKind: NonNullable<NotebookDiffDocument['resolution']>['kind']
  currentUpstreamRevisionId?: string
}) {
  const { store } = useNotebookStore()
  const [revisions, setRevisions] = useState<DriveRevision[]>([])
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!store) {
      setRevisions([])
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const nextRevisions = await store.listDriveRevisions(localUri)
        if (!cancelled) {
          setRevisions(sortDriveRevisions(nextRevisions))
        }
      } catch {
        if (!cancelled) {
          setError('Unable to load Drive revisions.')
          setRevisions([])
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [localUri, store])

  const selectRevision = async (revisionId: string) => {
    if (!store || !revisionId || revisionId === selectedRevisionId) {
      return
    }

    setApplying(true)
    setError(null)
    try {
      await openNotebookDriveRevisionDiff(store, localUri, revisionId, {
        resolutionKind,
        currentUpstreamRevisionId,
      })
    } catch {
      setError('Unable to load selected Drive revision.')
      showToast({
        message: 'Unable to load selected Drive revision. Please try again.',
        tone: 'error',
      })
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="flex flex-col gap-1 normal-case tracking-normal">
      <label
        htmlFor="drive-revision-select"
        className="text-[11px] font-medium uppercase tracking-wide text-nb-text-muted"
      >
        Compare against
      </label>
      <select
        id="drive-revision-select"
        className="max-w-full rounded border border-nb-border bg-white px-2 py-1 text-sm font-normal normal-case text-nb-text"
        disabled={!store || loading || applying}
        value={selectedRevisionId ?? ''}
        onChange={(event) => {
          void selectRevision(event.target.value)
        }}
      >
        {!selectedRevisionId && <option value="">Select a revision</option>}
        {selectedRevisionId &&
          !revisions.some((revision) => revision.id === selectedRevisionId) && (
            <option value={selectedRevisionId}>
              {currentRevisionLabel(selectedRevisionId)}
            </option>
          )}
        {revisions.map((revision) =>
          revision.id ? (
            <option key={revision.id} value={revision.id}>
              {revisionLabel(revision)}
            </option>
          ) : null
        )}
      </select>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </div>
  )
}

function currentRevisionLabel(revisionId: string): string {
  return `Current revision ${revisionId}`
}

function DiffRow({
  row,
  conflictLocalUri,
  onConflictDocumentChanged,
}: {
  row: CellDiff
  conflictLocalUri?: string
  onConflictDocumentChanged: (document: NotebookDiffDocument) => void
}) {
  if (row.kind === 'unchanged') {
    return (
      <details className="rounded border border-nb-border bg-nb-surface-2 text-sm text-nb-text-muted">
        <summary className="cursor-pointer px-3 py-2">
          Unchanged cell {row.baseCell?.refId || row.compareCell?.refId || ''}
        </summary>
        <div className="border-t border-nb-border bg-nb-bg p-3">
          <div className="grid min-w-[920px] grid-cols-2 gap-3">
            <CellPanel row={row} side="base" />
            <CellPanel row={row} side="compare" />
          </div>
        </div>
      </details>
    )
  }

  return (
    <section className="rounded-lg border border-nb-border bg-nb-bg p-3 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge color={changeBadgeColor(row.kind)}>{statusText(row)}</Badge>
          {row.outputDiff?.changed && (
            <Badge color="blue">outputs changed</Badge>
          )}
          {row.metadataDiff?.changed && (
            <Badge color="purple">metadata changed</Badge>
          )}
        </div>
        {conflictLocalUri && row.kind === 'deleted' && (
          <RestoreDeletedCellButton
            localUri={conflictLocalUri}
            row={row}
            onRestored={onConflictDocumentChanged}
          />
        )}
      </div>
      <div className="grid min-w-[920px] grid-cols-2 gap-3">
        <CellPanel row={row} side="base" />
        <CellPanel row={row} side="compare" />
      </div>
    </section>
  )
}

function ConflictResolutionActions({ localUri }: { localUri: string }) {
  const { store } = useNotebookStore()
  const [isResolving, setIsResolving] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const saveLocalVersion = async (force = false) => {
    if (!store) {
      return
    }
    setIsResolving(true)
    try {
      await store.resolveConflictWithLocal(localUri, {
        force,
      })
      showToast({
        message: 'Saved local notebook version to upstream.',
        tone: 'success',
      })
    } catch (error) {
      if (error instanceof NotebookConflictChangedError && !force) {
        const shouldOverwrite =
          typeof window !== 'undefined' &&
          window.confirm(
            'The upstream file changed again since this conflict was detected. ' +
              'Saving local version will replace the latest upstream version.'
          )
        if (shouldOverwrite) {
          await saveLocalVersion(true)
        }
        return
      }
      showToast({
        message: 'Unable to save local version. Please try again.',
        tone: 'error',
      })
    } finally {
      setIsResolving(false)
    }
  }

  const refreshDiff = async () => {
    if (!store) {
      return
    }
    setIsRefreshing(true)
    try {
      await refreshNotebookConflictDiff(store, localUri)
      showToast({
        message: 'Refreshed diff against latest upstream version.',
        tone: 'success',
      })
    } catch {
      showToast({
        message: 'Unable to refresh conflict diff. Please try again.',
        tone: 'error',
      })
    } finally {
      setIsRefreshing(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button
        type="button"
        color="gray"
        variant="soft"
        disabled={!store || isRefreshing || isResolving}
        onClick={() => {
          void refreshDiff()
        }}
      >
        {isRefreshing ? 'Refreshing...' : 'Refresh diff'}
      </Button>
      <Button
        type="button"
        color="amber"
        disabled={!store || isResolving || isRefreshing}
        onClick={() => {
          void saveLocalVersion()
        }}
      >
        {isResolving ? 'Saving...' : 'Save local version'}
      </Button>
    </div>
  )
}

export function NotebookDiffContent({
  document,
}: {
  document: NotebookDiffDocument
}) {
  const [currentDocument, setCurrentDocument] = useState(document)

  useEffect(() => {
    setCurrentDocument(document)
  }, [document])

  const { diff } = currentDocument
  const conflictResolution =
    currentDocument.resolution?.kind === 'notebook-sync-conflict'
      ? currentDocument.resolution
      : null
  const activeConflictResolution =
    conflictResolution && currentDocument.base.label === 'Upstream version'
      ? conflictResolution
      : null
  const driveRevisionResolution =
    currentDocument.resolution?.kind === 'notebook-sync-conflict' ||
    currentDocument.resolution?.kind === 'drive-upstream-diff'
      ? currentDocument.resolution
      : null

  return (
    <div className="flex h-full w-full flex-col bg-nb-surface">
      <header className="border-b border-nb-border bg-white px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Text as="p" size="5" weight="bold" className="text-nb-text">
              Notebook Diff
            </Text>
            <Text as="p" size="2" className="text-nb-text-muted">
              {currentDocument.base.label} compared with{' '}
              {currentDocument.compare.label}
            </Text>
            {activeConflictResolution && (
              <Text
                as="p"
                size="2"
                className="mt-2 max-w-3xl text-nb-text-muted"
              >
                This notebook has local changes and upstream changes. Review the
                diff, edit the local notebook if needed, then save the local
                version to replace upstream.
              </Text>
            )}
          </div>
          {activeConflictResolution && (
            <ConflictResolutionActions
              localUri={activeConflictResolution.localUri}
            />
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-sm text-nb-text-muted">
          <Badge color="green">{diff.summary.insertedCells} inserted</Badge>
          <Badge color="red">{diff.summary.deletedCells} deleted</Badge>
          <Badge color="amber">{diff.summary.modifiedCells} modified</Badge>
          <Badge color="blue">
            {diff.summary.outputChanges} output changes
          </Badge>
          <Badge color="gray">{diff.summary.unchangedCells} unchanged</Badge>
        </div>
        <div className="mt-4 grid min-w-[920px] grid-cols-2 gap-3 overflow-x-auto text-xs font-medium uppercase tracking-wide text-nb-text-muted">
          <div className="rounded border border-nb-border bg-nb-surface-2 px-3 py-2">
            <div>Base: {currentDocument.base.label}</div>
            {driveRevisionResolution && (
              <div className="mt-2">
                <DriveRevisionSelector
                  localUri={driveRevisionResolution.localUri}
                  selectedRevisionId={currentDocument.base.revisionId}
                  resolutionKind={driveRevisionResolution.kind}
                  currentUpstreamRevisionId={
                    driveRevisionResolution.upstreamRevisionId ??
                    (currentDocument.base.label === 'Upstream version'
                      ? currentDocument.base.revisionId
                      : undefined)
                  }
                />
              </div>
            )}
          </div>
          <div className="rounded border border-nb-border bg-nb-surface-2 px-3 py-2">
            Compare: {currentDocument.compare.label}
          </div>
        </div>
      </header>
      <ScrollArea type="auto" scrollbars="both" className="min-h-0 flex-1">
        <div className="space-y-3 p-5">
          {diff.cells.map((row) => (
            <DiffRow
              key={row.id}
              row={row}
              conflictLocalUri={activeConflictResolution?.localUri}
              onConflictDocumentChanged={setCurrentDocument}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
