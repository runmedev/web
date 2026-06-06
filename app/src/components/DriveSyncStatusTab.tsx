import { Button, Text } from '@radix-ui/themes'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useCurrentDoc } from '../contexts/CurrentDocContext'
import { useGoogleAuth } from '../contexts/GoogleAuthContext'
import { useNotebookContext } from '../contexts/NotebookContext'
import { useNotebookStore } from '../contexts/NotebookStoreContext'
import { useWorkspaceDocumentContext } from '../contexts/WorkspaceDocumentContext'
import type {
  NotebookSyncStatus,
  NotebookSyncStatusRow,
} from '../storage/local'

type SortDirection = 'asc' | 'desc'

type SortKey = keyof Pick<
  NotebookSyncStatusRow,
  | 'localUri'
  | 'title'
  | 'googleDriveUrl'
  | 'revision'
  | 'upstreamRevision'
  | 'lastSynced'
  | 'syncStatus'
>

type FilterKey = Exclude<SortKey, 'lastSynced' | 'syncStatus'>

type Filters = Record<FilterKey, string>

const emptyFilters: Filters = {
  localUri: '',
  title: '',
  googleDriveUrl: '',
  revision: '',
  upstreamRevision: '',
}

const stringColumns: Array<{
  key: FilterKey
  label: string
  className: string
}> = [
  { key: 'localUri', label: 'Local URI', className: 'min-w-[240px]' },
  { key: 'title', label: 'Title', className: 'min-w-[180px]' },
  {
    key: 'googleDriveUrl',
    label: 'Google Drive URL',
    className: 'min-w-[260px]',
  },
  { key: 'revision', label: 'Revision', className: 'min-w-[150px]' },
  {
    key: 'upstreamRevision',
    label: 'Upstream Revision',
    className: 'min-w-[170px]',
  },
]

const syncStatusOptions: NotebookSyncStatus[] = [
  'local-only',
  'synced',
  'pending',
  'pending-upstream-create',
  'syncing',
  'conflicted',
  'error',
]

const columnDescriptions: Record<SortKey, string> = {
  localUri: 'Stable browser-local identifier for the cached notebook record.',
  title: 'Notebook title stored in the local mirror.',
  googleDriveUrl:
    'Upstream Google Drive file URL, when this local record is backed by Drive.',
  revision:
    'Local content checksum used to detect unsynced local edits. This is usually an MD5 hash, not a Google Drive revision ID.',
  upstreamRevision:
    'Latest upstream version observed during sync. For Drive files this is the Google Drive headRevisionId when available; otherwise it falls back to the upstream checksum.',
  lastSynced:
    'Time of the last successful local-to-upstream or upstream-to-local sync.',
  syncStatus:
    'Computed local sync state, such as synced, pending, syncing, conflicted, error, or local-only.',
}

function isAutoSyncable(status: NotebookSyncStatus): boolean {
  return (
    status === 'pending' ||
    status === 'pending-upstream-create' ||
    status === 'error'
  )
}

function formatDate(value: string | undefined): string {
  if (!value) {
    return 'Never'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString()
}

function statusClassName(status: NotebookSyncStatus): string {
  switch (status) {
    case 'synced':
      return 'bg-emerald-50 text-emerald-700'
    case 'pending':
    case 'pending-upstream-create':
      return 'bg-amber-50 text-amber-700'
    case 'syncing':
      return 'bg-sky-50 text-sky-700'
    case 'conflicted':
      return 'bg-orange-50 text-orange-700'
    case 'error':
      return 'bg-red-50 text-red-700'
    case 'local-only':
      return 'bg-slate-100 text-slate-700'
    default:
      return 'bg-slate-100 text-slate-700'
  }
}

function compareRows(
  left: NotebookSyncStatusRow,
  right: NotebookSyncStatusRow,
  key: SortKey,
  direction: SortDirection
): number {
  const multiplier = direction === 'asc' ? 1 : -1
  if (key === 'lastSynced') {
    const leftTime = left.lastSynced ? Date.parse(left.lastSynced) : 0
    const rightTime = right.lastSynced ? Date.parse(right.lastSynced) : 0
    return (leftTime - rightTime) * multiplier
  }

  const leftValue = String(left[key] ?? '').toLocaleLowerCase()
  const rightValue = String(right[key] ?? '').toLocaleLowerCase()
  return leftValue.localeCompare(rightValue) * multiplier
}

function ColumnHelp({
  label,
  description,
}: {
  label: string
  description: string
}) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [pinned, setPinned] = useState(false)
  const open = hovered || focused || pinned
  const tooltipId = `drive-sync-column-help-${label
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')}`

  return (
    <span
      className="relative inline-flex items-center normal-case tracking-normal"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-nb-border bg-white text-[10px] font-bold leading-none text-nb-text-muted hover:border-nb-accent hover:text-nb-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nb-accent"
        aria-label={`About ${label}`}
        aria-describedby={open ? tooltipId : undefined}
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation()
          setPinned((current) => !current)
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          setPinned(false)
        }}
      >
        ?
      </button>
      {open ? (
        <span
          id={tooltipId}
          role="tooltip"
          className="absolute left-1/2 top-6 z-30 w-64 -translate-x-1/2 whitespace-normal rounded-nb-sm border border-nb-border bg-white px-3 py-2 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-nb-text shadow-nb-md"
        >
          {description}
        </span>
      ) : null}
    </span>
  )
}

function SortButton({
  label,
  column,
  sortKey,
  sortDirection,
  onSort,
}: {
  label: string
  column: SortKey
  sortKey: SortKey
  sortDirection: SortDirection
  onSort: (column: SortKey) => void
}) {
  const active = sortKey === column
  const indicator = active ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 whitespace-nowrap text-left font-semibold text-nb-text-muted hover:text-nb-text"
      onClick={() => onSort(column)}
      aria-label={`Sort by ${label}`}
    >
      {label}
      <span className="text-xs text-nb-text-faint" aria-hidden="true">
        {indicator}
      </span>
    </button>
  )
}

function ColumnHeader({
  label,
  column,
  sortKey,
  sortDirection,
  onSort,
}: {
  label: string
  column: SortKey
  sortKey: SortKey
  sortDirection: SortDirection
  onSort: (column: SortKey) => void
}) {
  return (
    <div className="flex items-center gap-1.5">
      <SortButton
        label={label}
        column={column}
        sortKey={sortKey}
        sortDirection={sortDirection}
        onSort={onSort}
      />
      <ColumnHelp label={label} description={columnDescriptions[column]} />
    </div>
  )
}

function SyncStatusFilter({
  selectedStatuses,
  onToggleStatus,
  onClear,
}: {
  selectedStatuses: NotebookSyncStatus[]
  onToggleStatus: (status: NotebookSyncStatus) => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const selected = new Set(selectedStatuses)
  const summary =
    selectedStatuses.length === 0
      ? 'All statuses'
      : `${selectedStatuses.length} selected`

  useEffect(() => {
    if (!open) {
      return
    }

    const handleOutsidePress = (event: Event) => {
      const target = event.target
      if (target instanceof Node && containerRef.current?.contains(target)) {
        return
      }
      setOpen(false)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', handleOutsidePress)
    document.addEventListener('mousedown', handleOutsidePress)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePress)
      document.removeEventListener('mousedown', handleOutsidePress)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div
      ref={containerRef}
      className="relative mt-2 text-xs font-normal normal-case tracking-normal text-nb-text"
    >
      <button
        type="button"
        className="flex w-full cursor-pointer list-none items-center justify-between rounded-nb-sm border border-nb-border bg-white px-2 py-1 outline-none hover:border-nb-accent focus:border-nb-accent"
        aria-label={`Filter Sync Status: ${summary}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>Filter Sync Status: {summary}</span>
        <span className="text-[10px] text-nb-text-faint">v</span>
      </button>
      {open ? (
        <div
          className="absolute right-0 top-8 z-30 w-56 rounded-nb-sm border border-nb-border bg-white p-2 text-left shadow-nb-md"
          role="menu"
        >
          <div className="flex flex-col gap-1">
            {syncStatusOptions.map((status) => (
              <label
                key={status}
                className="flex cursor-pointer items-center gap-2 rounded-nb-sm px-2 py-1 hover:bg-nb-surface-2"
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5"
                  checked={selected.has(status)}
                  onChange={() => onToggleStatus(status)}
                  aria-label={`Filter Sync Status: ${status}`}
                />
                <span>{status}</span>
              </label>
            ))}
          </div>
          <button
            type="button"
            className="mt-2 w-full rounded-nb-sm border border-nb-border px-2 py-1 text-xs text-nb-text-muted hover:border-nb-accent hover:text-nb-text disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onClear}
            disabled={selectedStatuses.length === 0}
          >
            Clear status filters
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function DriveSyncStatusTab() {
  const { store } = useNotebookStore()
  const { ensureAccessToken, isDriveSyncing } = useGoogleAuth()
  const { setCurrentDoc } = useCurrentDoc()
  const { openNotebook } = useNotebookContext()
  const { showDocument } = useWorkspaceDocumentContext()
  const [rows, setRows] = useState<NotebookSyncStatusRow[]>([])
  const [loading, setLoading] = useState(false)
  const [syncingAll, setSyncingAll] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFilters] = useState<Filters>(emptyFilters)
  const [selectedSyncStatuses, setSelectedSyncStatuses] = useState<
    NotebookSyncStatus[]
  >([])
  const [sortKey, setSortKey] = useState<SortKey>('title')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')

  const refresh = useCallback(() => {
    if (!store) {
      setRows([])
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const nextRows = await store.listFileSyncStatuses()
        if (!cancelled) {
          setRows(nextRows)
          setError(null)
        }
      } catch (refreshError) {
        if (!cancelled) {
          setError(String(refreshError))
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
  }, [store])

  useEffect(() => refresh(), [refresh])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const onStoreUpdated = () => {
      refresh()
    }
    window.addEventListener('local-notebook-sync-updated', onStoreUpdated)
    window.addEventListener('local-notebook-updated', onStoreUpdated)
    return () => {
      window.removeEventListener('local-notebook-sync-updated', onStoreUpdated)
      window.removeEventListener('local-notebook-updated', onStoreUpdated)
    }
  }, [refresh])

  const rowsRequiringSync = useMemo(
    () => rows.filter((row) => isAutoSyncable(row.syncStatus)),
    [rows]
  )

  const filteredRows = useMemo(() => {
    return rows
      .filter((row) => {
        if (
          selectedSyncStatuses.length > 0 &&
          !selectedSyncStatuses.includes(row.syncStatus)
        ) {
          return false
        }

        return (Object.keys(filters) as FilterKey[]).every((key) => {
          const filter = filters[key].trim().toLocaleLowerCase()
          if (!filter) {
            return true
          }
          const value = String(row[key] ?? '').toLocaleLowerCase()
          return value.startsWith(filter)
        })
      })
      .sort((left, right) => compareRows(left, right, sortKey, sortDirection))
  }, [filters, rows, selectedSyncStatuses, sortDirection, sortKey])

  const handleSort = useCallback(
    (column: SortKey) => {
      if (sortKey === column) {
        setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
        return
      }
      setSortKey(column)
      setSortDirection('asc')
    },
    [sortKey]
  )

  const handleSyncAll = useCallback(async () => {
    if (!store || rowsRequiringSync.length === 0) {
      return
    }
    setSyncingAll(true)
    setError(null)
    try {
      const rowsNotRequiringDriveAuth = rowsRequiringSync.filter(
        (row) => !row.googleDriveUrl
      )
      const rowsRequiringDriveAuth = rowsRequiringSync.filter(
        (row) => row.googleDriveUrl
      )
      await Promise.all(
        rowsNotRequiringDriveAuth.map((row) => store.sync(row.localUri))
      )
      if (rowsRequiringDriveAuth.length > 0) {
        await ensureAccessToken({ interactive: true })
      }
      await Promise.all(
        rowsRequiringDriveAuth.map((row) => store.sync(row.localUri))
      )
      refresh()
    } catch (syncError) {
      setError(String(syncError))
    } finally {
      setSyncingAll(false)
    }
  }, [ensureAccessToken, refresh, rowsRequiringSync, store])

  const handleToggleSyncStatusFilter = useCallback(
    (status: NotebookSyncStatus) => {
      setSelectedSyncStatuses((current) =>
        current.includes(status)
          ? current.filter((item) => item !== status)
          : [...current, status]
      )
    },
    []
  )

  const handleOpenLocalUri = useCallback(
    async (localUri: string) => {
      setError(null)
      try {
        const result = await openNotebook(localUri)
        showDocument(result.localUri, {
          title: result.entry.name,
        })
        setCurrentDoc(result.localUri)
      } catch (openError) {
        setError(String(openError))
      }
    },
    [openNotebook, setCurrentDoc, showDocument]
  )

  return (
    <div
      className="flex h-full min-h-0 flex-1 overflow-hidden p-4"
      data-testid="drive-sync-status-scroll"
    >
      <div className="flex h-full min-h-0 w-full flex-1 flex-col gap-5 text-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <Text size="5" weight="bold" as="p" className="text-nb-text">
              Google Drive Sync Status
            </Text>
            <Text size="2" as="p" className="text-nb-text-muted">
              {rows.length === 0
                ? 'No local files are currently tracked.'
                : `${filteredRows.length} of ${rows.length} local files shown.`}
            </Text>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                isDriveSyncing
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-red-50 text-red-700'
              }`}
            >
              Drive {isDriveSyncing ? 'connected' : 'not connected'}
            </span>
            <Button
              type="button"
              variant="soft"
              onClick={() => refresh()}
              disabled={loading || syncingAll || !store}
            >
              Refresh
            </Button>
            <Button
              type="button"
              onClick={() => void handleSyncAll()}
              disabled={!store || rowsRequiringSync.length === 0 || syncingAll}
            >
              {syncingAll
                ? 'Syncing...'
                : `Sync Required (${rowsRequiringSync.length})`}
            </Button>
          </div>
        </div>

        {error ? (
          <pre
            className="whitespace-pre-wrap rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-900"
            data-testid="drive-sync-status-error"
          >
            {error}
          </pre>
        ) : null}

        {!store ? (
          <div className="rounded-lg border border-nb-border bg-white p-4">
            <Text size="2" as="p" className="text-nb-text-muted">
              Notebook storage is still initializing.
            </Text>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-nb-border bg-white">
            <table className="w-max min-w-full border-collapse text-left text-sm">
              <thead>
                <tr className="sticky top-0 z-10 border-b border-nb-border bg-nb-surface-2 text-xs uppercase tracking-wide">
                  {stringColumns.map((column) => (
                    <th
                      key={column.key}
                      className={`${column.className} px-3 py-2 align-top`}
                    >
                      <ColumnHeader
                        label={column.label}
                        column={column.key}
                        sortKey={sortKey}
                        sortDirection={sortDirection}
                        onSort={handleSort}
                      />
                      <input
                        type="search"
                        className="mt-2 w-full rounded-nb-sm border border-nb-border bg-white px-2 py-1 text-xs font-normal normal-case tracking-normal text-nb-text outline-none focus:border-nb-accent"
                        placeholder={`Filter ${column.label}`}
                        value={filters[column.key]}
                        onChange={(event) =>
                          setFilters((current) => ({
                            ...current,
                            [column.key]: event.target.value,
                          }))
                        }
                        aria-label={`Filter ${column.label}`}
                      />
                    </th>
                  ))}
                  <th className="min-w-[170px] px-3 py-2 align-top">
                    <ColumnHeader
                      label="Last Synced"
                      column="lastSynced"
                      sortKey={sortKey}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                    />
                  </th>
                  <th className="min-w-[150px] px-3 py-2 align-top">
                    <ColumnHeader
                      label="Sync Status"
                      column="syncStatus"
                      sortKey={sortKey}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                    />
                    <SyncStatusFilter
                      selectedStatuses={selectedSyncStatuses}
                      onToggleStatus={handleToggleSyncStatusFilter}
                      onClear={() => setSelectedSyncStatuses([])}
                    />
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-3 py-8 text-center text-nb-text-muted"
                    >
                      {loading ? 'Loading sync status...' : 'No files match.'}
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((row) => (
                    <tr
                      key={row.localUri}
                      className="border-b border-nb-border last:border-0"
                    >
                      <td className="max-w-[280px] break-all px-3 py-3 font-mono text-xs text-nb-text-muted">
                        <a
                          className="text-nb-accent hover:underline"
                          href={row.localUri}
                          onClick={(event) => {
                            event.preventDefault()
                            void handleOpenLocalUri(row.localUri)
                          }}
                        >
                          {row.localUri}
                        </a>
                      </td>
                      <td className="max-w-[240px] px-3 py-3 font-medium text-nb-text">
                        {row.title}
                      </td>
                      <td className="max-w-[320px] break-all px-3 py-3 font-mono text-xs text-nb-text-muted">
                        {row.googleDriveUrl ? (
                          <a
                            className="text-nb-accent hover:underline"
                            href={row.googleDriveUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {row.googleDriveUrl}
                          </a>
                        ) : (
                          <span className="text-nb-text-faint">None</span>
                        )}
                      </td>
                      <td className="max-w-[180px] break-all px-3 py-3 font-mono text-xs text-nb-text-muted">
                        {row.revision || 'None'}
                      </td>
                      <td className="max-w-[200px] break-all px-3 py-3 font-mono text-xs text-nb-text-muted">
                        {row.upstreamRevision || 'None'}
                      </td>
                      <td className="px-3 py-3 text-nb-text-muted">
                        {formatDate(row.lastSynced)}
                      </td>
                      <td className="px-3 py-3">
                        <span
                          className={`rounded-full px-2 py-1 text-xs font-semibold ${statusClassName(row.syncStatus)}`}
                          title={row.lastError}
                        >
                          {row.syncStatus}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

export default DriveSyncStatusTab
