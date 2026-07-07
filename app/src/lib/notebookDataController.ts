import { create } from '@bufbuild/protobuf'

import { parser_pb } from '../contexts/CellContext'
import type { LocalNotebooks } from '../storage/local'
import { appLogger } from './logging/runtime'
import { NotebookData, type NotebookSnapshot } from './notebookData'
import { getNotebookSessionPersistence } from './notebookSessionPersistence'
import type { NotebookDataLike } from './runtime/runmeConsole'
import {
  type ForceReleaseHandlerResult,
  type ForceReleaseRequest,
  type NotebookLease,
  type NotebookOwnershipManager,
  type NotebookOwnershipMessage,
  type NotebookOwnershipRecord,
  getNotebookOwnershipManager,
} from './tabCoordination/notebookOwnership'

export type NotebookTabState =
  | 'resolving'
  | 'loading'
  | 'loaded'
  | 'blocked'
  | 'error'

export interface OpenNotebookEntry {
  uri: string
  requestedUri: string
  name: string
  state: NotebookTabState
  readOnly?: boolean
  releasePending?: boolean
  writeAccessRequestState?: 'pending' | 'error'
  writeAccessErrorMessage?: string
  refreshErrorMessage?: string
  errorMessage?: string
  owner?: NotebookOwnershipRecord | null
}

export interface OpenNotebookResult {
  localUri: string
  entry: OpenNotebookEntry
}

export interface OpenNotebookOptions {
  name?: string
  loadReadOnly?: boolean
}

export interface NotebookDataControllerSnapshot {
  openNotebooks: OpenNotebookEntry[]
}

type NotebookDataHandle = {
  data: NotebookData
  unsubscribe: () => void
  loaded: boolean
}

function createEmptyNotebook(): parser_pb.Notebook {
  return create(parser_pb.NotebookSchema, {
    cells: [],
    metadata: {},
  })
}

function isLocalFileUri(uri: string): boolean {
  return uri.startsWith('local://file/')
}

function deriveDisplayName(uri: string): string {
  try {
    const url = new URL(uri)
    const tail = url.pathname.split('/').filter(Boolean).pop()
    if (tail) {
      return decodeURIComponent(tail)
    }
  } catch {
    // Fall through to the URI segment heuristic.
  }
  return uri.split('/').filter(Boolean).pop() ?? uri
}

export class NotebookDataController {
  private static instance: NotebookDataController | null = null

  static getInstance(): NotebookDataController {
    if (!NotebookDataController.instance) {
      NotebookDataController.instance = new NotebookDataController()
    }
    return NotebookDataController.instance
  }

  static resetForTests(): void {
    NotebookDataController.instance?.dispose()
    NotebookDataController.instance = null
  }

  private localNotebooks: LocalNotebooks | null = null
  private ownershipManager: NotebookOwnershipManager =
    getNotebookOwnershipManager()
  private readonly notebooks = new Map<string, NotebookDataHandle>()
  private readonly leases = new Map<string, NotebookLease>()
  private openNotebooks: OpenNotebookEntry[] = []
  private readonly listeners = new Set<() => void>()
  private snapshot: NotebookDataControllerSnapshot = { openNotebooks: [] }
  private restored = false
  private readonly releasingNotebooks = new Set<string>()
  private readonly writeAccessRequests = new Map<
    string,
    Promise<OpenNotebookResult>
  >()
  private unsubscribeOwnershipMessages: (() => void) | null = null
  private unregisterForceReleaseHandler: (() => void) | null = null

  private constructor() {
    this.bindOwnershipManager()
  }

  getSnapshot(): NotebookDataControllerSnapshot {
    this.ensureRestored()
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.ensureRestored()
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  configureStores(options: { localNotebooks: LocalNotebooks | null }): void {
    this.ensureRestored()
    this.localNotebooks = options.localNotebooks
    for (const handle of this.notebooks.values()) {
      const uri = handle.data.getUri()
      handle.data.setNotebookStore(
        this.leases.has(uri) && !handle.data.isReadOnly()
          ? this.createOwnedNotebookStore(uri)
          : null
      )
    }
    if (this.localNotebooks) {
      void this.loadOpenNotebooks()
    }
  }

  configureOwnershipManager(manager: NotebookOwnershipManager): void {
    this.unbindOwnershipManager()
    this.ownershipManager = manager
    this.bindOwnershipManager()
  }

  async openNotebook(
    uri: string,
    options?: OpenNotebookOptions
  ): Promise<OpenNotebookResult> {
    this.ensureRestored()
    const requestedUri = uri.trim()
    if (!requestedUri) {
      throw new Error('openNotebook requires a non-empty URI')
    }

    const localUri = await this.resolveLocalUri(requestedUri, options?.name)
    const name = await this.resolveNotebookName(localUri, options?.name)
    let entry = this.upsertOpenEntry({
      uri: localUri,
      requestedUri,
      name,
      state: 'loading',
      readOnly: false,
      releasePending: false,
      writeAccessRequestState: undefined,
      writeAccessErrorMessage: undefined,
      refreshErrorMessage: undefined,
      errorMessage: undefined,
      owner: undefined,
    })

    const acquireResult = await this.ownershipManager.acquire(localUri)
    if (acquireResult.status === 'unsupported') {
      entry = this.upsertOpenEntry({
        ...entry,
        state: 'error',
        errorMessage:
          'This browser does not support safe multi-tab notebook ownership. Use a browser with Web Locks support, or close other Runme tabs before editing.',
      })
      return { localUri, entry }
    }
    if (acquireResult.status === 'blocked') {
      if (options?.loadReadOnly === false) {
        entry = this.upsertOpenEntry({
          ...entry,
          state: 'blocked',
          readOnly: false,
          owner: acquireResult.owner,
          errorMessage: undefined,
        })
        return { localUri, entry }
      }
      const handle = this.ensureNotebookData({
        uri: localUri,
        name,
        loaded: false,
        readOnly: true,
      })
      entry = this.upsertOpenEntry({
        ...entry,
        state: 'loading',
        readOnly: true,
        owner: acquireResult.owner,
        errorMessage: undefined,
      })
      if (this.localNotebooks) {
        try {
          const notebook = await this.localNotebooks.load(localUri)
          handle.data.setNotebookStore(null)
          handle.data.setReadOnly(true)
          handle.data.loadNotebook(notebook, { persist: false })
          handle.loaded = true
          entry = this.upsertOpenEntry({
            ...entry,
            name: await this.resolveNotebookName(localUri, name),
            state: 'loaded',
            readOnly: true,
            owner: acquireResult.owner,
            errorMessage: undefined,
          })
        } catch (error) {
          entry = this.upsertOpenEntry({
            ...entry,
            state: 'error',
            readOnly: true,
            owner: acquireResult.owner,
            errorMessage: `Notebook could not be opened read-only: ${String(error)}`,
          })
        }
      }
      return { localUri, entry }
    }
    this.leases.set(localUri, acquireResult.lease)

    const existingWasReadOnly =
      this.notebooks.get(localUri)?.data.isReadOnly() ?? false

    const handle = this.ensureNotebookData({
      uri: localUri,
      name,
      loaded: false,
      readOnly: existingWasReadOnly,
    })

    if (handle.loaded && !existingWasReadOnly) {
      handle.data.setNotebookStore(this.createOwnedNotebookStore(localUri))
      handle.data.setReadOnly(false)
      entry = this.upsertOpenEntry({
        ...entry,
        name: handle.data.getName(),
        state: 'loaded',
        readOnly: false,
        releasePending: false,
        writeAccessRequestState: undefined,
        writeAccessErrorMessage: undefined,
        refreshErrorMessage: undefined,
        errorMessage: undefined,
        owner: undefined,
      })
      return { localUri, entry }
    }

    if (this.localNotebooks) {
      try {
        const notebook = await this.localNotebooks.load(localUri)
        handle.data.loadNotebook(notebook, { persist: false })
        handle.data.setNotebookStore(this.createOwnedNotebookStore(localUri))
        handle.data.setReadOnly(false)
        handle.loaded = true
        entry = this.upsertOpenEntry({
          ...entry,
          name: await this.resolveNotebookName(localUri, name),
          state: 'loaded',
          readOnly: false,
          releasePending: false,
          writeAccessRequestState: undefined,
          writeAccessErrorMessage: undefined,
          refreshErrorMessage: undefined,
          errorMessage: undefined,
          owner: undefined,
        })
      } catch (error) {
        this.releaseLease(localUri)
        entry = this.upsertOpenEntry({
          ...entry,
          state: 'error',
          errorMessage: String(error),
        })
      }
    }

    return { localUri, entry }
  }

  closeNotebook(localUri: string): string | null {
    this.ensureRestored()
    const index = this.openNotebooks.findIndex((item) => item.uri === localUri)
    if (index === -1) {
      return null
    }
    const fallback =
      index > 0
        ? (this.openNotebooks[index - 1]?.uri ?? null)
        : (this.openNotebooks[index + 1]?.uri ?? null)
    this.removeNotebook(localUri)
    return fallback
  }

  getNotebookData(localUri: string): NotebookData | undefined {
    return this.notebooks.get(localUri)?.data
  }

  getOpenNotebooks(): OpenNotebookEntry[] {
    this.ensureRestored()
    return this.openNotebooks
  }

  getNotebookSnapshot(localUri: string): NotebookSnapshot | null {
    return this.getNotebookData(localUri)?.getSnapshot() ?? null
  }

  requestWriteAccess(localUri: string): Promise<OpenNotebookResult> {
    const pending = this.writeAccessRequests.get(localUri)
    if (pending) {
      return pending
    }
    const request = this.requestWriteAccessInternal(localUri).finally(() => {
      if (this.writeAccessRequests.get(localUri) === request) {
        this.writeAccessRequests.delete(localUri)
      }
    })
    this.writeAccessRequests.set(localUri, request)
    return request
  }

  private async requestWriteAccessInternal(
    localUri: string
  ): Promise<OpenNotebookResult> {
    this.ensureRestored()
    const entry = this.openNotebooks.find((item) => item.uri === localUri)
    if (!entry) {
      throw new Error(`Notebook ${localUri} is not open.`)
    }

    this.upsertOpenEntry({
      ...entry,
      writeAccessRequestState: 'pending',
      writeAccessErrorMessage: undefined,
    })
    try {
      const immediate = await this.openNotebook(localUri, { name: entry.name })
      if (!immediate.entry.readOnly && immediate.entry.state === 'loaded') {
        return immediate
      }
      if (immediate.entry.state === 'error' && !immediate.entry.readOnly) {
        return immediate
      }
      const currentEntry =
        this.openNotebooks.find((item) => item.uri === localUri) ?? entry
      this.upsertOpenEntry({
        ...currentEntry,
        writeAccessRequestState: 'pending',
        writeAccessErrorMessage: undefined,
      })

      const result = await this.ownershipManager.requestForceRelease(localUri)
      if (result.status !== 'released') {
        return this.setWriteAccessError(localUri, currentEntry, result.message)
      }

      const reopened = await this.openNotebook(localUri, { name: entry.name })
      if (reopened.entry.readOnly || reopened.entry.state !== 'loaded') {
        return this.setWriteAccessError(
          localUri,
          reopened.entry,
          'Write access was released, but another session acquired it first. Retry to request access again.'
        )
      }
      return reopened
    } catch (error) {
      return this.setWriteAccessError(
        localUri,
        entry,
        `Could not request write access: ${String(error)}`
      )
    }
  }

  private setWriteAccessError(
    localUri: string,
    fallbackEntry: OpenNotebookEntry,
    message: string
  ): OpenNotebookResult {
    const nextEntry = this.openNotebooks.find((item) => item.uri === localUri)
    const failedEntry = this.upsertOpenEntry({
      ...(nextEntry ?? fallbackEntry),
      writeAccessRequestState: 'error',
      writeAccessErrorMessage: message,
    })
    return { localUri, entry: failedEntry }
  }

  async refreshReadOnlyNotebook(localUri: string): Promise<void> {
    const entry = this.openNotebooks.find((item) => item.uri === localUri)
    if (!entry?.readOnly) {
      return
    }
    await this.reloadReadOnlyNotebook(localUri, entry.owner ?? null)
  }

  async forceReleaseNotebook(
    request: ForceReleaseRequest
  ): Promise<ForceReleaseHandlerResult> {
    const localUri = request.notebookUri
    const lease = this.leases.get(localUri)
    if (!lease || !(await lease.isCurrentOwner())) {
      return { status: 'not-owner' }
    }
    if (this.releasingNotebooks.has(localUri)) {
      return {
        status: 'busy',
        message:
          'The other session is already processing a write-access request.',
      }
    }

    const handle = this.notebooks.get(localUri)
    const entry = this.openNotebooks.find((item) => item.uri === localUri)
    if (!handle || !entry) {
      return {
        status: 'failed',
        message: 'The owning session no longer has the notebook open.',
      }
    }

    this.releasingNotebooks.add(localUri)
    try {
      try {
        handle.data.setReleasePending(true)
        this.upsertOpenEntry({
          ...entry,
          releasePending: true,
          writeAccessErrorMessage: undefined,
        })
        await handle.data.cancelActiveExecutions()
        await handle.data.flushPendingPersist()
      } catch (error) {
        const currentEntry = this.openNotebooks.find(
          (item) => item.uri === localUri
        )
        if (
          currentEntry &&
          this.notebooks.get(localUri) === handle &&
          this.leases.get(localUri) === lease
        ) {
          handle.data.setReleasePending(false)
          handle.data.setReadOnly(false)
          handle.data.setNotebookStore(this.createOwnedNotebookStore(localUri))
          this.upsertOpenEntry({
            ...currentEntry,
            state: 'loaded',
            readOnly: false,
            releasePending: false,
            writeAccessErrorMessage: `Could not save changes before releasing write access: ${String(error)}`,
          })
        }
        return {
          status: 'failed',
          message: `The other session could not save changes before releasing the lock: ${String(error)}`,
        }
      }

      // Closing the notebook releases its lease. Do not let this asynchronous
      // request mutate a notebook that was closed or subsequently reopened.
      if (
        !this.openNotebooks.some((item) => item.uri === localUri) ||
        this.notebooks.get(localUri) !== handle ||
        this.leases.get(localUri) !== lease
      ) {
        return { status: 'released' }
      }

      // From this point onward the old session must never become writable again.
      // Cleanup failures after release cannot restore an authoritative Web Lock.
      lease.release()
      try {
        await lease.released
      } catch (error) {
        appLogger.error('Notebook lease cleanup failed after release', {
          attrs: { scope: 'notebook-session', localUri, error },
        })
      }
      if (this.leases.get(localUri) === lease) {
        this.leases.delete(localUri)
      }
      const currentEntry = this.openNotebooks.find(
        (item) => item.uri === localUri
      )
      if (!currentEntry || this.notebooks.get(localUri) !== handle) {
        return { status: 'released' }
      }
      handle.data.setNotebookStore(null)
      handle.data.setReadOnly(true)
      handle.data.setReleasePending(false)
      try {
        this.upsertOpenEntry({
          ...currentEntry,
          state: 'loaded',
          readOnly: true,
          releasePending: false,
          owner: null,
          errorMessage: undefined,
        })
      } catch (error) {
        appLogger.error('Failed to persist released notebook UI state', {
          attrs: { scope: 'notebook-session', localUri, error },
        })
      }

      try {
        const newOwner = await this.ownershipManager.getOwner(localUri)
        if (newOwner && newOwner.epoch !== lease.epoch) {
          await this.reloadReadOnlyNotebook(localUri, newOwner)
        }
      } catch (error) {
        appLogger.error('Failed to refresh notebook after ownership transfer', {
          attrs: { scope: 'notebook-session', localUri, error },
        })
      }
      return { status: 'released' }
    } finally {
      this.releasingNotebooks.delete(localUri)
    }
  }

  private async resolveLocalUri(uri: string, name?: string): Promise<string> {
    if (isLocalFileUri(uri)) {
      return uri
    }
    if (!this.localNotebooks) {
      throw new Error('Notebook store is not ready')
    }
    return this.localNotebooks.addFile(uri, name)
  }

  private async resolveNotebookName(
    uri: string,
    fallbackName?: string
  ): Promise<string> {
    if (fallbackName?.trim()) {
      return fallbackName
    }
    if (this.localNotebooks && uri.startsWith('local://')) {
      try {
        const metadata = await this.localNotebooks.getMetadata(uri)
        if (metadata?.name) {
          return metadata.name
        }
      } catch {
        // Fall back to URI-derived name.
      }
    }
    return deriveDisplayName(uri)
  }

  private ensureNotebookData({
    uri,
    name,
    notebook,
    loaded = false,
    readOnly = false,
  }: {
    uri: string
    name: string
    notebook?: parser_pb.Notebook
    loaded?: boolean
    readOnly?: boolean
  }): NotebookDataHandle {
    const existing = this.notebooks.get(uri)
    if (existing) {
      existing.data.setNotebookStore(
        readOnly ? null : this.createOwnedNotebookStore(uri)
      )
      existing.data.setReadOnly(readOnly)
      return existing
    }

    const data = new NotebookData({
      uri,
      name,
      notebook: notebook ?? createEmptyNotebook(),
      notebookStore: readOnly ? null : this.createOwnedNotebookStore(uri),
      loaded,
      readOnly,
      resolveNotebookForAppKernel: (target?: unknown) => {
        const targetUri = this.resolveTargetUri(target)
        if (!targetUri) {
          return this.getReadableNotebookData(uri)
        }
        return this.getReadableNotebookData(targetUri)
      },
      listNotebooksForAppKernel: () => this.listNotebookDataLike(uri),
    })
    const unsubscribe = data.subscribe(() => {
      this.updateOpenEntryName(data.getUri(), data.getName())
      this.emit()
    })
    const handle = { data, unsubscribe, loaded }
    this.notebooks.set(uri, handle)
    this.emit()
    return handle
  }

  private resolveTargetUri(target?: unknown): string | null {
    if (typeof target === 'string' && target.trim() !== '') {
      return target.trim()
    }
    if (
      typeof target === 'object' &&
      target &&
      'uri' in target &&
      typeof (target as { uri?: unknown }).uri === 'string' &&
      (target as { uri: string }).uri.trim() !== ''
    ) {
      return (target as { uri: string }).uri.trim()
    }
    if (
      typeof target === 'object' &&
      target &&
      'handle' in target &&
      typeof (target as { handle?: { uri?: unknown } }).handle?.uri ===
        'string' &&
      (target as { handle: { uri: string } }).handle.uri.trim() !== ''
    ) {
      return (target as { handle: { uri: string } }).handle.uri.trim()
    }
    return null
  }

  private listNotebookDataLike(currentUri: string): NotebookDataLike[] {
    const notebooksByUri = new Map<string, NotebookDataLike>()
    for (const handle of this.notebooks.values()) {
      notebooksByUri.set(handle.data.getUri(), handle.data)
    }
    const current = this.getReadableNotebookData(currentUri)
    if (current && !notebooksByUri.has(current.getUri())) {
      notebooksByUri.set(current.getUri(), current)
    }
    return Array.from(notebooksByUri.values())
  }

  private getOwnedNotebookData(uri: string): NotebookData | null {
    if (!this.leases.has(uri)) {
      return null
    }
    return this.notebooks.get(uri)?.data ?? null
  }

  private getReadableNotebookData(uri: string): NotebookData | null {
    return this.notebooks.get(uri)?.data ?? null
  }

  private updateOpenEntryName(uri: string, name: string): void {
    let changed = false
    this.openNotebooks = this.openNotebooks.map((item) => {
      if (item.uri !== uri || item.name === name) {
        return item
      }
      changed = true
      return {
        ...item,
        name,
      }
    })
    if (changed) {
      this.persist()
    }
  }

  private upsertOpenEntry(entry: OpenNotebookEntry): OpenNotebookEntry {
    let changed = false
    const next = this.openNotebooks.map((item) => {
      if (item.uri !== entry.uri) {
        return item
      }
      changed = true
      return entry
    })
    this.openNotebooks = changed ? next : [...this.openNotebooks, entry]
    this.emit()
    this.persist()
    return entry
  }

  private removeNotebook(uri: string): void {
    this.releaseLease(uri)
    const handle = this.notebooks.get(uri)
    if (handle) {
      handle.unsubscribe()
    }
    this.notebooks.delete(uri)
    this.openNotebooks = this.openNotebooks.filter((item) => item.uri !== uri)
    this.emit()
    this.persist()
  }

  private releaseLease(uri: string): void {
    this.leases.get(uri)?.release()
    this.leases.delete(uri)
  }

  private bindOwnershipManager(): void {
    this.unregisterForceReleaseHandler =
      this.ownershipManager.setForceReleaseHandler((request) =>
        this.forceReleaseNotebook(request)
      )
    this.unsubscribeOwnershipMessages =
      this.ownershipManager.subscribeToMessages((message) => {
        this.handleOwnershipMessage(message)
      })
  }

  private unbindOwnershipManager(): void {
    this.unregisterForceReleaseHandler?.()
    this.unregisterForceReleaseHandler = null
    this.unsubscribeOwnershipMessages?.()
    this.unsubscribeOwnershipMessages = null
  }

  private handleOwnershipMessage(message: NotebookOwnershipMessage): void {
    if (message.type !== 'owner-acquired') {
      return
    }
    if (this.leases.has(message.record.notebookUri)) {
      return
    }
    const handle = this.notebooks.get(message.record.notebookUri)
    if (!handle?.data.isReadOnly()) {
      return
    }
    void this.reloadReadOnlyNotebook(message.record.notebookUri, message.record)
  }

  private async reloadReadOnlyNotebook(
    localUri: string,
    owner: NotebookOwnershipRecord | null
  ): Promise<void> {
    const handle = this.notebooks.get(localUri)
    const entry = this.openNotebooks.find((item) => item.uri === localUri)
    if (
      !handle ||
      !entry ||
      !handle.data.isReadOnly() ||
      this.leases.has(localUri) ||
      !this.localNotebooks
    ) {
      return
    }
    try {
      const notebook = await this.localNotebooks.load(localUri)
      handle.data.setNotebookStore(null)
      handle.data.setReleasePending(false)
      handle.data.setReadOnly(true)
      handle.data.loadNotebook(notebook, { persist: false })
      handle.loaded = true
      this.upsertOpenEntry({
        ...entry,
        name: await this.resolveNotebookName(localUri, entry.name),
        state: 'loaded',
        readOnly: true,
        releasePending: false,
        owner,
        refreshErrorMessage: undefined,
        errorMessage: undefined,
      })
    } catch (error) {
      this.upsertOpenEntry({
        ...entry,
        state: 'loaded',
        readOnly: true,
        releasePending: false,
        owner,
        refreshErrorMessage: `Could not refresh the read-only notebook: ${String(error)}`,
      })
    }
  }

  private async loadOpenNotebooks(): Promise<void> {
    if (!this.localNotebooks) {
      return
    }
    const restored = [...this.openNotebooks]
    for (const item of restored) {
      if (this.notebooks.get(item.uri)?.loaded) {
        continue
      }
      void this.openNotebook(item.requestedUri || item.uri, {
        name: item.name,
        loadReadOnly: false,
      })
    }
  }

  private ensureRestored(): void {
    if (this.restored) {
      return
    }
    this.restored = true
    this.openNotebooks = getNotebookSessionPersistence().loadOpenNotebooks()
    this.rebuildSnapshot()
  }

  private emit(): void {
    this.rebuildSnapshot()
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        appLogger.error('NotebookDataController listener failed', {
          attrs: { scope: 'notebook-session', error },
        })
      }
    }
  }

  private persist(): void {
    getNotebookSessionPersistence().saveOpenNotebooks(this.openNotebooks)
  }

  private rebuildSnapshot(): void {
    this.snapshot = {
      openNotebooks: this.openNotebooks.map((item) => ({ ...item })),
    }
  }

  private dispose(): void {
    this.unbindOwnershipManager()
    for (const lease of this.leases.values()) {
      lease.release()
    }
    this.leases.clear()
    for (const handle of this.notebooks.values()) {
      handle.unsubscribe()
    }
    this.notebooks.clear()
    this.openNotebooks = []
    this.listeners.clear()
    this.releasingNotebooks.clear()
    this.writeAccessRequests.clear()
    this.snapshot = { openNotebooks: [] }
    this.restored = false
    this.localNotebooks = null
  }

  private createOwnedNotebookStore(uri: string) {
    if (!this.localNotebooks) {
      return null
    }
    return {
      save: async (saveUri: string, notebook: parser_pb.Notebook) => {
        const lease = this.leases.get(uri)
        if (!lease || !(await lease.isCurrentOwner())) {
          throw new Error(`Notebook ${uri} is not owned by this browser tab.`)
        }
        return this.localNotebooks?.save(saveUri, notebook)
      },
    }
  }
}

export function getNotebookDataController(): NotebookDataController {
  return NotebookDataController.getInstance()
}

export function __resetNotebookDataControllerForTests(): void {
  NotebookDataController.resetForTests()
}
