import type { DriveNotebookStore, DriveRevision } from '../../storage/drive'
import { isDriveItemUri } from '../../storage/drive'
import type LocalNotebooks from '../../storage/local'
import type { NotebookTarget, NotebooksApi } from '../runtime/runmeConsole'
import type { NotebookDataLike } from '../runtime/runmeConsole'
import {
  type RestoreDeletedConflictCellOptions,
  type RestoredConflictCellResult,
  loadNotebookConflictDiffDocument,
  restoreDeletedConflictCell,
} from './conflict'
import { computeNotebookDiff } from './diff'
import type { CellDiff, CellDiffKind, NotebookDiffDocument } from './model'
import {
  openNotebookDiffDocument,
  registerNotebookDiffDocument,
} from './registry'

export type DriveNotebookRevision = DriveRevision & { id: string }
type NotebookDiffTarget =
  | NotebookTarget
  | { getUri: () => string }
  | null
  | undefined

type ConflictDiffArgs =
  | NotebookDiffTarget
  | {
      target?: NotebookDiffTarget
      localUri?: string
    }

type RestoreDeletedCellArgs = ConflictDiffArgs & {
  refId?: string
  rowId?: string
}

export type ConflictCellSummary = {
  id: string
  kind: CellDiffKind
  baseIndex?: number
  compareIndex?: number
  baseRefId?: string
  compareRefId?: string
  baseValue?: string
  compareValue?: string
}

export type NotebookDiffRuntimeApi = {
  listDriveRevisions: (
    target?: NotebookDiffTarget
  ) => Promise<DriveNotebookRevision[]>
  diffDriveRevision: (args: {
    target?: NotebookDiffTarget
    revisionId: string
    includeOutputs?: boolean
    includeMetadata?: boolean
  }) => Promise<NotebookDiffDocument>
  openDiffTab: (diff: NotebookDiffDocument | { id: string }) => Promise<void>
  openConflictDiff: (args?: ConflictDiffArgs) => Promise<NotebookDiffDocument>
  listConflictCells: (args?: ConflictDiffArgs) => Promise<ConflictCellSummary[]>
  restoreDeletedCell: (
    args?: RestoreDeletedCellArgs
  ) => Promise<RestoredConflictCellResult>
  restoreAllDeletedCells: (
    args?: ConflictDiffArgs
  ) => Promise<RestoredConflictCellResult>
  help: () => string
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function toDriveNotebookRevision(
  revision: DriveRevision
): DriveNotebookRevision | null {
  const id = optionalString(revision.id)
  if (!id) {
    return null
  }
  const lastModifyingUser =
    revision.lastModifyingUser && typeof revision.lastModifyingUser === 'object'
      ? {
          displayName: optionalString(revision.lastModifyingUser.displayName),
          emailAddress: optionalString(revision.lastModifyingUser.emailAddress),
        }
      : undefined

  return {
    id,
    mimeType: optionalString(revision.mimeType),
    modifiedTime: optionalString(revision.modifiedTime),
    md5Checksum: optionalString(revision.md5Checksum),
    size: optionalString(revision.size),
    keepForever:
      typeof revision.keepForever === 'boolean'
        ? revision.keepForever
        : undefined,
    lastModifyingUser,
  }
}

function normalizeTarget(
  target?: NotebookDiffTarget
): NotebookTarget | undefined {
  if (!target) {
    return undefined
  }
  if (hasGetUri(target)) {
    return { uri: target.getUri() }
  }
  return target
}

function hasLocalUri(value: unknown): value is { localUri: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { localUri?: unknown }).localUri === 'string'
  )
}

function hasTarget(value: unknown): value is { target?: NotebookDiffTarget } {
  return !!value && typeof value === 'object' && 'target' in value
}

function summarizeConflictCell(row: CellDiff): ConflictCellSummary {
  return {
    id: row.id,
    kind: row.kind,
    baseIndex: row.baseIndex,
    compareIndex: row.compareIndex,
    baseRefId: row.baseCell?.refId,
    compareRefId: row.compareCell?.refId,
    baseValue: row.baseCell?.value,
    compareValue: row.compareCell?.value,
  }
}

function hasGetUri(
  target: NotebookDiffTarget
): target is { getUri: () => string } {
  return (
    !!target && typeof (target as { getUri?: unknown }).getUri === 'function'
  )
}

export function createNotebookDiffRuntimeApi({
  notebooksApi,
  resolveLocalNotebooks,
  resolveDriveNotebookStore,
  resolveNotebook,
}: {
  notebooksApi: NotebooksApi
  resolveLocalNotebooks: () => LocalNotebooks | null
  resolveDriveNotebookStore: () => DriveNotebookStore | null
  resolveNotebook?: (target?: NotebookTarget) => NotebookDataLike | null
}): NotebookDiffRuntimeApi {
  const resolveDriveRemoteUri = async (target?: NotebookDiffTarget) => {
    const doc = await notebooksApi.get(normalizeTarget(target))
    const localStore = resolveLocalNotebooks()
    if (!localStore) {
      throw new Error('Local notebook mirror store is not initialized yet.')
    }
    const metadata = await localStore.getMetadata(doc.handle.uri)
    const remoteUri = metadata?.remoteUri
    if (!remoteUri || !isDriveItemUri(remoteUri)) {
      throw new Error(
        `Notebook ${doc.handle.uri} is not backed by a Google Drive file.`
      )
    }
    return { doc, remoteUri }
  }

  const requireDriveStore = () => {
    const driveStore = resolveDriveNotebookStore()
    if (!driveStore) {
      throw new Error('Google Drive notebook store is not initialized yet.')
    }
    return driveStore
  }

  const resolveConflictLocalUri = async (args?: ConflictDiffArgs) => {
    if (typeof args === 'string') {
      return args
    }
    if (hasLocalUri(args)) {
      return args.localUri
    }
    const target = hasTarget(args) ? args.target : args
    const doc = await notebooksApi.get(normalizeTarget(target))
    return doc.handle.uri
  }

  const loadConflictDiff = async (args?: ConflictDiffArgs) => {
    const localStore = resolveLocalNotebooks()
    if (!localStore) {
      throw new Error('Local notebook mirror store is not initialized yet.')
    }
    const localUri = await resolveConflictLocalUri(args)
    return {
      localStore,
      localUri,
      document: await loadNotebookConflictDiffDocument(localStore, localUri),
    }
  }

  const resolveLiveNotebook = (
    localUri: string,
    args?: ConflictDiffArgs
  ): NotebookDataLike | null => {
    if (!resolveNotebook) {
      return null
    }
    if (hasLocalUri(args)) {
      return resolveNotebook({ uri: localUri })
    }
    const target = hasTarget(args) ? args.target : args
    const notebook = resolveNotebook(normalizeTarget(target))
    if (notebook?.getUri() === localUri) {
      return notebook
    }
    return resolveNotebook({ uri: localUri })
  }

  const resolveLiveNotebookOptions = async (
    localUri: string,
    args?: ConflictDiffArgs
  ): Promise<RestoreDeletedConflictCellOptions> => {
    const notebook = resolveLiveNotebook(localUri, args)
    if (!notebook || notebook.getUri() !== localUri) {
      return {}
    }
    await notebook.flushPendingPersist?.()
    return {
      localNotebook: notebook.getNotebook(),
    }
  }

  const refreshLiveNotebook = (
    localUri: string,
    notebook: RestoredConflictCellResult['localNotebook'],
    args?: ConflictDiffArgs
  ) => {
    const liveNotebook = resolveLiveNotebook(localUri, args)
    if (liveNotebook?.getUri() === localUri) {
      liveNotebook.loadNotebook?.(notebook, { persist: false })
    }
  }

  const selectDeletedRow = (
    rows: CellDiff[],
    args?: RestoreDeletedCellArgs
  ): CellDiff => {
    const refId = typeof args?.refId === 'string' ? args.refId : undefined
    const rowId = typeof args?.rowId === 'string' ? args.rowId : undefined
    const row = rows.find((candidate) => {
      if (candidate.kind !== 'deleted') {
        return false
      }
      if (rowId) {
        return candidate.id === rowId
      }
      if (refId) {
        return candidate.baseCell?.refId === refId
      }
      return true
    })
    if (!row) {
      throw new Error(
        refId || rowId
          ? `No deleted upstream conflict cell matched ${refId ?? rowId}.`
          : 'No deleted upstream conflict cells remain to restore.'
      )
    }
    return row
  }

  return {
    listDriveRevisions: async (target?: NotebookDiffTarget) => {
      const { remoteUri } = await resolveDriveRemoteUri(target)
      const revisions = await requireDriveStore().listRevisions(remoteUri)
      return revisions.flatMap((revision) => {
        const normalized = toDriveNotebookRevision(revision)
        return normalized ? [normalized] : []
      })
    },
    diffDriveRevision: async (args) => {
      if (!args?.revisionId?.trim()) {
        throw new Error('notebookDiff.diffDriveRevision requires revisionId.')
      }
      const { doc, remoteUri } = await resolveDriveRemoteUri(args.target)
      const driveStore = requireDriveStore()
      const baseNotebook = await driveStore.loadRevision(
        remoteUri,
        args.revisionId
      )
      const diff = computeNotebookDiff(baseNotebook, doc.notebook, {
        includeOutputs: args.includeOutputs ?? true,
        includeMetadata: args.includeMetadata ?? true,
      })
      diff.baseLabel = `Drive revision ${args.revisionId}`
      diff.compareLabel = 'Local copy'
      return registerNotebookDiffDocument({
        base: {
          label: diff.baseLabel,
          revisionId: args.revisionId,
        },
        compare: {
          label: diff.compareLabel,
          revisionId: doc.handle.revision,
        },
        diff,
      })
    },
    openDiffTab: async (diff) => {
      openNotebookDiffDocument(diff)
    },
    openConflictDiff: async (args) => {
      const { document } = await loadConflictDiff(args)
      openNotebookDiffDocument(document)
      return document
    },
    listConflictCells: async (args) => {
      const { document } = await loadConflictDiff(args)
      return document.diff.cells.map(summarizeConflictCell)
    },
    restoreDeletedCell: async (args) => {
      const { localStore, localUri, document } = await loadConflictDiff(args)
      const row = selectDeletedRow(document.diff.cells, args)
      const result = await restoreDeletedConflictCell(
        localStore,
        localUri,
        row,
        await resolveLiveNotebookOptions(localUri, args)
      )
      refreshLiveNotebook(localUri, result.localNotebook, args)
      return result
    },
    restoreAllDeletedCells: async (args) => {
      const { localStore, localUri, document } = await loadConflictDiff(args)
      const options = await resolveLiveNotebookOptions(localUri, args)
      let result: RestoredConflictCellResult | null = null
      for (const row of document.diff.cells) {
        if (row.kind !== 'deleted') {
          continue
        }
        result = await restoreDeletedConflictCell(
          localStore,
          localUri,
          row,
          result ? { localNotebook: result.localNotebook } : options
        )
      }
      if (!result) {
        throw new Error('No deleted upstream conflict cells remain to restore.')
      }
      refreshLiveNotebook(localUri, result.localNotebook, args)
      return result
    },
    help: () =>
      [
        'notebookDiff.listDriveRevisions(target?)',
        'notebookDiff.diffDriveRevision({ target?, revisionId, includeOutputs?, includeMetadata? })',
        'notebookDiff.openDiffTab(diffOrId)',
        'notebookDiff.openConflictDiff({ target?, localUri? })',
        'notebookDiff.listConflictCells({ target?, localUri? })',
        'notebookDiff.restoreDeletedCell({ target?, localUri?, refId?, rowId? })',
        'notebookDiff.restoreAllDeletedCells({ target?, localUri? })',
        'Example:',
        '  const doc = await notebooks.get();',
        '  const revisions = await notebookDiff.listDriveRevisions({ handle: doc.handle });',
        '  const diff = await notebookDiff.diffDriveRevision({ target: { handle: doc.handle }, revisionId: revisions.at(-2).id });',
        '  await notebookDiff.openDiffTab(diff);',
        '  await notebookDiff.restoreAllDeletedCells({ target: { handle: doc.handle } });',
      ].join('\n'),
  }
}
