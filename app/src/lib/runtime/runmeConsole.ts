import { create } from '@bufbuild/protobuf'
import md5 from 'md5'

import { RunmeMetadataKey, parser_pb } from '../../runme/client'
import { isHtmlLanguageId } from '../cellContent'

type CellRunnerLike = {
  run: () => void | Promise<void>
  getRunID: () => string
}

function isRunnableNotebookCodeCell(
  cell: parser_pb.Cell | null | undefined
): boolean {
  if (!cell || cell.kind !== parser_pb.CellKind.CODE) {
    return false
  }
  return !isHtmlLanguageId(cell.languageId)
}

export type NotebookDataLike = {
  getUri: () => string
  getName: () => string
  getNotebook: () => parser_pb.Notebook
  isReadOnly?: () => boolean
  flushPendingPersist?: () => Promise<void>
  loadNotebook?: (
    notebook: parser_pb.Notebook,
    options?: { persist?: boolean }
  ) => void
  updateCell: (cell: parser_pb.Cell) => void
  getCell: (refId: string) => CellRunnerLike | null
  appendCell?: (
    kind?: parser_pb.CellKind,
    languageId?: string | null
  ) => parser_pb.Cell
  addCellAfter?: (
    targetRefId: string,
    kind?: parser_pb.CellKind,
    languageId?: string | null
  ) => parser_pb.Cell | null
  addCellBefore?: (
    targetRefId: string,
    kind?: parser_pb.CellKind,
    languageId?: string | null
  ) => parser_pb.Cell | null
  removeCell?: (refId: string) => void
}

export type NotebookSummary = {
  uri: string
  name: string
  isOpen: boolean
  readOnly?: boolean
  source: 'local' | 'fs' | 'drive'
}

export type NotebookQuery = {
  openOnly?: boolean
  uriPrefix?: string
  nameContains?: string
  limit?: number
}

export type NotebookHandle = {
  uri: string
  revision: string
}

export type NotebookTarget = { uri: string } | { handle: NotebookHandle }

export type NotebookDocument = {
  summary: NotebookSummary
  handle: NotebookHandle
  notebook: parser_pb.Notebook
}

export type CellPatch = {
  value?: string
  languageId?: string
  metadata?: Record<string, string>
  outputs?: parser_pb.CellOutput[]
}

export type CellLocation =
  | { index: number }
  | { beforeRefId: string }
  | { afterRefId: string }

export type InsertCellSpec = {
  kind: 'code' | 'markup'
  languageId?: string
  value?: string
  metadata?: Record<string, string>
}

export type NotebookMutation =
  | {
      op: 'insert'
      at: CellLocation
      cells: InsertCellSpec[]
    }
  | {
      op: 'update'
      refId: string
      patch: CellPatch
    }
  | {
      op: 'remove'
      refIds: string[]
    }

export type NotebookUpdateOperationStatus =
  | { index: number; status: 'applied' }
  | { index: number; status: 'failed'; error: string }
  | { index: number; status: 'not_attempted' }

export type NotebookUpdateErrorDetails = {
  method: 'notebooks.update'
  code: 'NOTEBOOK_UPDATE_FAILED'
  failedOperationIndex: number
  failedOperation: unknown
  failedOperationError: string
  appliedOperationCount: number
  operationStatuses: NotebookUpdateOperationStatus[]
  beforeHandle: NotebookHandle
  afterHandle: NotebookHandle
}

export class NotebookUpdateError extends Error {
  readonly code = 'NOTEBOOK_UPDATE_FAILED'
  readonly details: NotebookUpdateErrorDetails

  constructor(details: NotebookUpdateErrorDetails) {
    super(
      `notebooks.update failed at operations[${details.failedOperationIndex}] ` +
        `after applying ${details.appliedOperationCount} operation(s): ` +
        details.failedOperationError
    )
    this.name = 'NotebookUpdateError'
    this.details = details
    Object.setPrototypeOf(this, NotebookUpdateError.prototype)
  }

  toJSON(): {
    name: string
    message: string
    code: typeof this.code
    details: NotebookUpdateErrorDetails
  } {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      details: this.details,
    }
  }
}

export type NotebookMethod = 'list' | 'get' | 'update' | 'delete' | 'execute'

export type NotebooksApi = {
  help: (topic?: NotebookMethod) => Promise<string>
  list: (query?: NotebookQuery) => Promise<NotebookSummary[]>
  get: (target?: NotebookTarget) => Promise<NotebookDocument>
  update: (args: {
    target?: NotebookTarget
    expectedRevision?: string
    operations: NotebookMutation[]
    reason?: string
  }) => Promise<NotebookDocument>
  delete: (target: NotebookTarget) => Promise<void>
  execute: (args: {
    target?: NotebookTarget
    refIds: string[]
  }) => Promise<{ handle: NotebookHandle; cells: parser_pb.Cell[] }>
}

export type RunmeConsoleApi = {
  getCurrentNotebook: () => NotebookDataLike | null
  clear: (target?: unknown) => string
  clearOutputs: (target?: unknown) => string
  runAll: (target?: unknown) => string
  rerun: (target?: unknown) => string
  help: () => string
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function inferNotebookSource(uri: string): NotebookSummary['source'] {
  const normalized = (uri ?? '').toLowerCase()
  if (normalized.startsWith('local://')) {
    return 'local'
  }
  if (normalized.startsWith('fs://') || normalized.startsWith('file://')) {
    return 'fs'
  }
  if (normalized.startsWith('https://drive.google.com/')) {
    return 'drive'
  }
  return 'local'
}

export function makeJsonSafe<T>(
  value: T,
  seen = new WeakMap<object, unknown>()
): T {
  if (typeof value === 'bigint') {
    return value.toString() as T
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (
    value instanceof Date ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    return value
  }
  const existing = seen.get(value)
  if (existing) {
    return existing as T
  }
  if (Array.isArray(value)) {
    const result: unknown[] = []
    seen.set(value, result)
    for (const item of value) {
      result.push(makeJsonSafe(item, seen))
    }
    return result as T
  }
  const result: Record<string, unknown> = {}
  seen.set(value, result)
  for (const [key, item] of Object.entries(value)) {
    result[key] = makeJsonSafe(item, seen)
  }
  return result as T
}

function stringifyJsonSafe(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? item.toString() : item
  )
}

function createRevision(notebook: parser_pb.Notebook): string {
  // Deterministic content hash used for optimistic checks in runtime helpers.
  return md5(stringifyJsonSafe(notebook))
}

function makeHandle(notebook: NotebookDataLike): NotebookHandle {
  return {
    uri: notebook.getUri(),
    revision: createRevision(notebook.getNotebook()),
  }
}

function makeDocument(notebook: NotebookDataLike): NotebookDocument {
  const handle = makeHandle(notebook)
  return {
    summary: {
      uri: notebook.getUri(),
      name: notebook.getName(),
      isOpen: true,
      readOnly: notebook.isReadOnly?.() ?? false,
      source: inferNotebookSource(notebook.getUri()),
    },
    handle,
    notebook: makeJsonSafe(notebook.getNotebook()),
  }
}

function resolveTargetUri(target?: NotebookTarget): string | null {
  if (target === undefined) {
    return null
  }
  if (!target || typeof target !== 'object') {
    throw new Error(
      `Invalid notebook target ${JSON.stringify(target)}. ` +
        `Use target: { uri: "local://..." } or target: { handle: { uri: "local://...", revision: "..." } }.`
    )
  }
  if (
    'uri' in target &&
    typeof target.uri === 'string' &&
    target.uri.trim() !== ''
  ) {
    return target.uri.trim()
  }
  if (
    'handle' in target &&
    target.handle &&
    typeof target.handle.uri === 'string' &&
    target.handle.uri.trim() !== ''
  ) {
    return target.handle.uri.trim()
  }
  throw new Error(
    `Invalid notebook target ${JSON.stringify(target)}. ` +
      `Use target: { uri: "local://..." } or target: { handle: { uri: "local://...", revision: "..." } }.`
  )
}

function formatMissingTargetError(
  method: 'update' | 'delete' | 'execute'
): string {
  if (method === 'update') {
    return (
      'notebooks.update requires an explicit target notebook. ' +
      'Pass target: { handle: doc.handle } after const doc = await notebooks.get(), ' +
      'or target: { uri: "local://..." }.'
    )
  }
  if (method === 'execute') {
    return (
      'notebooks.execute requires an explicit target notebook. ' +
      'Pass target: { handle: doc.handle } after const doc = await notebooks.get(), ' +
      'or target: { uri: "local://..." }.'
    )
  }
  return (
    'notebooks.delete requires an explicit target notebook. ' +
    'Pass target: { uri: "local://..." } or target: { handle: { uri: "local://...", revision: "..." } }.'
  )
}

function assertNotebookWritable(
  method: 'update' | 'delete' | 'execute' | 'clear' | 'runAll' | 'rerun',
  notebook: NotebookDataLike
): void {
  if (notebook.isReadOnly?.()) {
    throw new Error(
      `${method} is not allowed because notebook ${notebook.getUri()} is open read-only in this browser tab.`
    )
  }
}

function resolveInsertIndex(
  notebook: NotebookDataLike,
  at: CellLocation
): { beforeRefId?: string; afterRefId?: string; append?: true } {
  const cells = notebook.getNotebook().cells ?? []
  if ('beforeRefId' in at) {
    return { beforeRefId: at.beforeRefId }
  }
  if ('afterRefId' in at) {
    return { afterRefId: at.afterRefId }
  }
  const rawIndex = at.index
  if (!Number.isInteger(rawIndex)) {
    throw new Error(`Invalid insert index: ${String(rawIndex)}`)
  }
  if (cells.length === 0) {
    return { append: true }
  }
  let normalizedIndex = rawIndex
  if (rawIndex < 0) {
    normalizedIndex = cells.length + rawIndex + 1
  }
  if (normalizedIndex <= 0) {
    return { beforeRefId: cells[0]?.refId }
  }
  if (normalizedIndex >= cells.length) {
    return { append: true }
  }
  return { beforeRefId: cells[normalizedIndex]?.refId }
}

function applyInsertedCellSpec(
  notebook: NotebookDataLike,
  inserted: parser_pb.Cell,
  spec: InsertCellSpec
): void {
  const updated = create(parser_pb.CellSchema, inserted)
  updated.kind =
    spec.kind === 'markup' ? parser_pb.CellKind.MARKUP : parser_pb.CellKind.CODE
  updated.languageId =
    spec.languageId ??
    (spec.kind === 'markup' ? 'markdown' : (updated.languageId ?? 'javascript'))
  if (typeof spec.value === 'string') {
    updated.value = spec.value
  }
  if (spec.metadata) {
    updated.metadata = {
      ...(updated.metadata ?? {}),
      ...spec.metadata,
    }
  }
  notebook.updateCell(updated)
}

function appendCellForSpec(
  notebook: NotebookDataLike,
  spec: InsertCellSpec
): parser_pb.Cell {
  const kind =
    spec.kind === 'markup' ? parser_pb.CellKind.MARKUP : parser_pb.CellKind.CODE
  return notebook.appendCell!(
    kind,
    spec.languageId ?? (spec.kind === 'code' ? 'javascript' : undefined)
  )
}

function addCellBeforeForSpec(
  notebook: NotebookDataLike,
  targetRefId: string,
  spec: InsertCellSpec
): parser_pb.Cell | null {
  const kind =
    spec.kind === 'markup' ? parser_pb.CellKind.MARKUP : parser_pb.CellKind.CODE
  return notebook.addCellBefore!(
    targetRefId,
    kind,
    spec.languageId ?? (spec.kind === 'code' ? 'javascript' : undefined)
  )
}

function addCellAfterForSpec(
  notebook: NotebookDataLike,
  targetRefId: string,
  spec: InsertCellSpec
): parser_pb.Cell | null {
  const kind =
    spec.kind === 'markup' ? parser_pb.CellKind.MARKUP : parser_pb.CellKind.CODE
  return notebook.addCellAfter!(
    targetRefId,
    kind,
    spec.languageId ?? (spec.kind === 'code' ? 'javascript' : undefined)
  )
}

function assertValidInsertCellSpecs(specs: InsertCellSpec[]): void {
  if (!Array.isArray(specs) || specs.length === 0) {
    return
  }

  for (const [index, spec] of specs.entries()) {
    const kind = (spec as { kind?: unknown } | null)?.kind
    if (kind !== 'code' && kind !== 'markup') {
      throw new Error(
        `Invalid notebooks.update insert cell kind at cells[${index}]: ${JSON.stringify(kind)}. ` +
          'Expected "code" or "markup"; use "markup" for Markdown cells.'
      )
    }
  }
}

function insertCells(
  notebook: NotebookDataLike,
  at: CellLocation,
  specs: InsertCellSpec[]
): void {
  if (!Array.isArray(specs) || specs.length === 0) {
    return
  }

  assertValidInsertCellSpecs(specs)

  if (
    typeof notebook.appendCell !== 'function' ||
    typeof notebook.addCellBefore !== 'function' ||
    typeof notebook.addCellAfter !== 'function' ||
    typeof notebook.removeCell !== 'function'
  ) {
    throw new Error('Notebook does not support insert operations.')
  }

  const location = resolveInsertIndex(notebook, at)
  const insertedRefIds: string[] = []
  const rollbackInsertedCells = () => {
    for (let i = insertedRefIds.length - 1; i >= 0; i -= 1) {
      notebook.removeCell!(insertedRefIds[i]!)
    }
  }

  try {
    if (location.beforeRefId) {
      for (let i = specs.length - 1; i >= 0; i -= 1) {
        const spec = specs[i]!
        const inserted = addCellBeforeForSpec(
          notebook,
          location.beforeRefId,
          spec
        )
        if (!inserted) {
          throw new Error(
            `Failed to insert before cell: ${location.beforeRefId}`
          )
        }
        insertedRefIds.push(inserted.refId)
        applyInsertedCellSpec(notebook, inserted, spec)
      }
      return
    }

    if (location.afterRefId) {
      let anchor = location.afterRefId
      for (const spec of specs) {
        const inserted = addCellAfterForSpec(notebook, anchor, spec)
        if (!inserted) {
          throw new Error(`Failed to insert after cell: ${anchor}`)
        }
        insertedRefIds.push(inserted.refId)
        applyInsertedCellSpec(notebook, inserted, spec)
        anchor = inserted.refId
      }
      return
    }

    for (const spec of specs) {
      const inserted = appendCellForSpec(notebook, spec)
      insertedRefIds.push(inserted.refId)
      applyInsertedCellSpec(notebook, inserted, spec)
    }
  } catch (error) {
    rollbackInsertedCells()
    throw error
  }
}

function updateCellPatch(
  notebook: NotebookDataLike,
  refId: string,
  patch: CellPatch
): void {
  const existing = notebook
    .getNotebook()
    .cells.find((cell) => cell.refId === refId)
  if (!existing) {
    throw new Error(`Cell not found: ${refId}`)
  }
  const updated = create(parser_pb.CellSchema, existing)
  if (typeof patch.value === 'string') {
    updated.value = patch.value
  }
  if (typeof patch.languageId === 'string') {
    updated.languageId = patch.languageId
  }
  if (patch.metadata) {
    updated.metadata = {
      ...(updated.metadata ?? {}),
      ...patch.metadata,
    }
  }
  if (Array.isArray(patch.outputs)) {
    updated.outputs = patch.outputs
  }
  notebook.updateCell(updated)
}

function formatNotebookMutationError(
  index: number,
  operation: unknown
): string {
  const op =
    operation && typeof operation === 'object' && 'op' in operation
      ? JSON.stringify((operation as { op?: unknown }).op)
      : JSON.stringify(operation)
  return (
    `Unsupported notebooks.update operation at operations[${index}]: ${op}. ` +
    `Supported ops are "insert", "update", and "remove". ` +
    `To append a cell, use ` +
    `operations: [{ op: "insert", at: { index: -1 }, cells: [{ kind: "code", languageId: "python", value: "print(\\"hello\\")" }] }].`
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function createOperationStatuses({
  operationCount,
  appliedOperationCount,
  failedOperationIndex,
  failedOperationError,
}: {
  operationCount: number
  appliedOperationCount: number
  failedOperationIndex: number
  failedOperationError: string
}): NotebookUpdateOperationStatus[] {
  return Array.from({ length: operationCount }, (_value, index) => {
    if (index < appliedOperationCount) {
      return { index, status: 'applied' }
    }
    if (index === failedOperationIndex) {
      return { index, status: 'failed', error: failedOperationError }
    }
    return { index, status: 'not_attempted' }
  })
}

function createNotebookUpdateError({
  operations,
  failedOperationIndex,
  error,
  appliedOperationCount,
  beforeHandle,
  afterHandle,
}: {
  operations: NotebookMutation[]
  failedOperationIndex: number
  error: unknown
  appliedOperationCount: number
  beforeHandle: NotebookHandle
  afterHandle: NotebookHandle
}): NotebookUpdateError {
  const failedOperationError = errorMessage(error)
  return new NotebookUpdateError({
    method: 'notebooks.update',
    code: 'NOTEBOOK_UPDATE_FAILED',
    failedOperationIndex,
    failedOperation: operations[failedOperationIndex],
    failedOperationError,
    appliedOperationCount,
    operationStatuses: createOperationStatuses({
      operationCount: operations.length,
      appliedOperationCount,
      failedOperationIndex,
      failedOperationError,
    }),
    beforeHandle,
    afterHandle,
  })
}

export function createNotebooksApi({
  resolveNotebook,
  listNotebooks,
}: {
  resolveNotebook: (target?: unknown) => NotebookDataLike | null
  listNotebooks?: () => NotebookDataLike[]
}): NotebooksApi {
  const resolveNotebookByTarget = (
    target?: NotebookTarget
  ): NotebookDataLike => {
    const uri = resolveTargetUri(target)
    const resolved = uri ? resolveNotebook(uri) : resolveNotebook()
    if (!resolved) {
      throw new Error('No notebook found for the requested target.')
    }
    return resolved
  }

  const resolveNotebookByRequiredTarget = (
    method: 'update' | 'delete' | 'execute',
    target?: NotebookTarget
  ): NotebookDataLike => {
    if (target === undefined) {
      throw new Error(formatMissingTargetError(method))
    }
    return resolveNotebookByTarget(target)
  }

  const listKnownNotebooks = (): NotebookDataLike[] => {
    const listed = listNotebooks?.() ?? []
    if (listed.length > 0) {
      return listed
    }
    const current = resolveNotebook()
    return current ? [current] : []
  }

  const help = async (topic?: NotebookMethod) => {
    if (topic === 'list') {
      return 'notebooks.list(query?: { openOnly?: boolean; uriPrefix?: string; nameContains?: string; limit?: number }): Promise<NotebookSummary[]>'
    }
    if (topic === 'get') {
      return 'notebooks.get(target?: { uri } | { handle: { uri, revision } }): Promise<NotebookDocument>. When target is omitted, returns the current notebook selected in the UI.'
    }
    if (topic === 'update') {
      return 'notebooks.update({ target, expectedRevision?, operations: NotebookMutation[] }): Promise<NotebookDocument>. target is required.'
    }
    if (topic === 'delete') {
      return 'notebooks.delete(target): Promise<void>. target is required.'
    }
    if (topic === 'execute') {
      return 'notebooks.execute({ target, refIds: string[] }): Promise<{ handle, cells }>. target is required.'
    }
    return [
      'Notebook SDK methods:',
      '- notebooks.list(query?)',
      '- notebooks.get(target?)              # omitted target = current UI notebook',
      '- notebooks.update({ target, expectedRevision?, operations })',
      '- notebooks.delete(target)',
      '- notebooks.execute({ target, refIds })',
      '- notebooks.help(topic?)',
    ].join('\n')
  }

  return {
    help,
    list: async (query?: NotebookQuery) => {
      const all = listKnownNotebooks()
      let result = all.map((notebook) => ({
        uri: notebook.getUri(),
        name: notebook.getName(),
        isOpen: true,
        readOnly: notebook.isReadOnly?.() ?? false,
        source: inferNotebookSource(notebook.getUri()),
      }))
      if (query?.uriPrefix) {
        result = result.filter((item) => item.uri.startsWith(query.uriPrefix!))
      }
      if (query?.nameContains) {
        const needle = query.nameContains.toLowerCase()
        result = result.filter((item) =>
          item.name.toLowerCase().includes(needle)
        )
      }
      if (typeof query?.limit === 'number' && query.limit >= 0) {
        result = result.slice(0, query.limit)
      }
      return result
    },
    get: async (target?: NotebookTarget) => {
      const notebook = resolveNotebookByTarget(target)
      return makeDocument(notebook)
    },
    update: async (args) => {
      const notebook = resolveNotebookByRequiredTarget('update', args.target)
      assertNotebookWritable('update', notebook)
      const beforeHandle = makeHandle(notebook)
      if (
        args.expectedRevision &&
        args.expectedRevision.trim() !== '' &&
        args.expectedRevision !== beforeHandle.revision
      ) {
        throw new Error(
          `Revision mismatch: expected ${args.expectedRevision}, actual ${beforeHandle.revision}`
        )
      }

      const operations = args.operations ?? []
      if (!Array.isArray(operations)) {
        throw new Error(
          `Invalid notebooks.update operations: expected an array of notebook mutations, got ${JSON.stringify(
            operations
          )}.`
        )
      }

      for (const [index, operation] of operations.entries()) {
        try {
          if (operation.op === 'insert') {
            assertValidInsertCellSpecs(operation.cells)
          }
        } catch (error) {
          throw createNotebookUpdateError({
            operations,
            failedOperationIndex: index,
            error,
            appliedOperationCount: 0,
            beforeHandle,
            afterHandle: makeHandle(notebook),
          })
        }
      }

      let appliedOperationCount = 0
      for (const [index, operation] of operations.entries()) {
        try {
          if (operation.op === 'insert') {
            insertCells(notebook, operation.at, operation.cells)
          } else if (operation.op === 'update') {
            updateCellPatch(notebook, operation.refId, operation.patch)
          } else if (operation.op === 'remove') {
            if (typeof notebook.removeCell !== 'function') {
              throw new Error('Notebook does not support remove operations.')
            }
            for (const refId of operation.refIds ?? []) {
              notebook.removeCell(refId)
            }
          } else {
            throw new Error(formatNotebookMutationError(index, operation))
          }
          appliedOperationCount += 1
        } catch (error) {
          throw createNotebookUpdateError({
            operations,
            failedOperationIndex: index,
            error,
            appliedOperationCount,
            beforeHandle,
            afterHandle: makeHandle(notebook),
          })
        }
      }

      return makeDocument(notebook)
    },
    delete: async (_target: NotebookTarget) => {
      const notebook = resolveNotebookByRequiredTarget('delete', _target)
      assertNotebookWritable('delete', notebook)
      throw new Error('notebooks.delete is not supported in v0 runtime.')
    },
    execute: async (args) => {
      const notebook = resolveNotebookByRequiredTarget('execute', args.target)
      assertNotebookWritable('execute', notebook)
      const executedCells: parser_pb.Cell[] = []
      const pendingRuns: Array<{
        refId: string
        runner: CellRunnerLike
        cell: parser_pb.Cell
      }> = []
      for (const refId of args.refIds ?? []) {
        const cell = notebook
          .getNotebook()
          .cells.find((candidate) => candidate.refId === refId)
        if (!cell) {
          throw new Error(`Cell not found: ${refId}`)
        }
        if (!isRunnableNotebookCodeCell(cell)) {
          throw new Error(`HTML cells are not runnable: ${refId}`)
        }
        const cellRunner = notebook.getCell(refId)
        if (!cellRunner) {
          throw new Error(`Cell not found: ${refId}`)
        }
        pendingRuns.push({ refId, runner: cellRunner, cell })
      }
      for (const pending of pendingRuns) {
        const runResult = pending.runner.run()
        if (isPromiseLike(runResult)) {
          await runResult
        }
        const cell =
          notebook
            .getNotebook()
            .cells.find((candidate) => candidate.refId === pending.refId) ??
          pending.cell
        if (cell) {
          executedCells.push(cell)
        }
      }
      return {
        handle: makeHandle(notebook),
        cells: executedCells,
      }
    },
  }
}

function formatNotebookLabel(notebook: NotebookDataLike): string {
  const name = notebook.getName()
  const uri = notebook.getUri()
  if (name && name !== uri) {
    return `${name} (${uri})`
  }
  return uri
}

function clearCellRunMetadata(cell: parser_pb.Cell): void {
  if (!cell.metadata) {
    return
  }
  delete cell.metadata[RunmeMetadataKey.LastRunID]
  delete cell.metadata[RunmeMetadataKey.Pid]
  delete cell.metadata[RunmeMetadataKey.ExitCode]
}

export function createRunmeConsoleApi({
  resolveNotebook,
}: {
  resolveNotebook: (target?: unknown) => NotebookDataLike | null
}): RunmeConsoleApi {
  const getCurrentNotebook = () => resolveNotebook()

  const clearOutputs = (target?: unknown) => {
    const notebookData = resolveNotebook(target)
    if (!notebookData) {
      return 'No active notebook found.'
    }
    assertNotebookWritable('clear', notebookData)

    const notebook = notebookData.getNotebook()
    const cells = notebook.cells ?? []
    let updatedCells = 0
    let clearedOutputs = 0

    for (const cell of cells) {
      if (!cell?.refId) {
        continue
      }
      const hasOutputs = (cell.outputs?.length ?? 0) > 0
      const hasRunMetadata =
        typeof cell.metadata?.[RunmeMetadataKey.LastRunID] === 'string' ||
        typeof cell.metadata?.[RunmeMetadataKey.Pid] === 'string' ||
        typeof cell.metadata?.[RunmeMetadataKey.ExitCode] === 'string'
      if (!hasOutputs && !hasRunMetadata) {
        continue
      }

      const updatedCell = create(parser_pb.CellSchema, cell)
      clearedOutputs += updatedCell.outputs.length
      updatedCell.outputs = []
      clearCellRunMetadata(updatedCell)
      notebookData.updateCell(updatedCell)
      updatedCells += 1
    }

    if (updatedCells === 0) {
      return `No cell outputs to clear in ${formatNotebookLabel(notebookData)}.`
    }

    return `Cleared ${clearedOutputs} output item group(s) across ${updatedCells} cell(s) in ${formatNotebookLabel(notebookData)}.`
  }

  const runAll = (target?: unknown) => {
    const notebookData = resolveNotebook(target)
    if (!notebookData) {
      return 'No active notebook found.'
    }
    assertNotebookWritable('runAll', notebookData)

    const notebook = notebookData.getNotebook()
    const cells = notebook.cells ?? []
    let runnableCells = 0
    let started = 0
    let failedToStart = 0

    for (const cell of cells) {
      if (!cell?.refId || !isRunnableNotebookCodeCell(cell)) {
        continue
      }
      if ((cell.value ?? '').trim().length === 0) {
        continue
      }
      runnableCells += 1

      const cellData = notebookData.getCell(cell.refId)
      if (!cellData) {
        failedToStart += 1
        continue
      }

      const previousRunID = cellData.getRunID()
      cellData.run()
      const runID = cellData.getRunID()
      if (runID && runID !== previousRunID) {
        started += 1
      } else {
        failedToStart += 1
      }
    }

    if (runnableCells === 0) {
      return `No runnable code cells found in ${formatNotebookLabel(notebookData)}.`
    }

    return `Started ${started}/${runnableCells} code cell(s) in ${formatNotebookLabel(notebookData)}.${failedToStart > 0 ? ` ${failedToStart} failed to start.` : ''}`
  }

  const clear = (target?: unknown) => clearOutputs(target)
  const rerun = (target?: unknown) => {
    const notebookData = resolveNotebook(target)
    if (!notebookData) {
      return 'No active notebook found.'
    }
    assertNotebookWritable('rerun', notebookData)

    const clearMessage = clearOutputs(notebookData)
    const runMessage = runAll(notebookData)
    return `${clearMessage}\n${runMessage}`
  }

  const help = () =>
    [
      'runme.clear()                  - Clear outputs in the current visible notebook',
      'runme.runAll()                 - Run all non-empty code cells in the current visible notebook',
      'runme.rerun()                  - Clear outputs, then run all cells in the current visible notebook',
      'runme.getCurrentNotebook()     - Advanced: return notebook handle for scripting',
      'runme.clearOutputs()           - Alias for runme.clear()',
      '',
      'Advanced optional target:',
      '  runme.clear(target)',
      '  runme.runAll(target)',
      '  runme.rerun(target)',
      '  target can be a notebook handle or notebook URI',
      'runme.help()                    - Show this help',
    ].join('\n')

  return {
    getCurrentNotebook,
    clear,
    clearOutputs,
    runAll,
    rerun,
    help,
  }
}
