import { canonicalJson } from './canonicalJson'
import { operationMap, orderOperationSet } from './order'
import { validateRecordShape } from './recordValidation'
import {
  type CommentRecord,
  type RevisionRecord,
  projectRecord,
  serializedRecord,
} from './records'
import {
  type JsonValue,
  type NotebookLogHeader,
  type ParsedOperationLog,
  RUNME_OPERATION_LOG_FORMAT_VERSION,
  type RunmeOperation,
} from './types'
import { validateRecordReferences } from './versions'

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

export function validateHeader(value: unknown): NotebookLogHeader {
  const header = requireObject(value, 'Notebook log header')
  if (header.record_type !== 'runme.notebook') {
    throw new Error('First record must have record_type runme.notebook')
  }
  if (
    ![1, RUNME_OPERATION_LOG_FORMAT_VERSION].includes(
      header.format_version as number
    )
  ) {
    throw new Error(
      `Unsupported notebook log format_version ${String(header.format_version)}`
    )
  }
  for (const field of ['notebook_id', 'created_by', 'created_at'] as const) {
    if (typeof header[field] !== 'string' || header[field].length === 0) {
      throw new Error(`Notebook log header requires ${field}`)
    }
  }
  return header as unknown as NotebookLogHeader
}

export function validateOperation(value: unknown): RunmeOperation {
  let operation = requireObject(value, 'Operation')
  if (
    operation.record_type === 'runme.revision' ||
    operation.record_type === 'runme.comment'
  ) {
    validateRecordShape(operation)
    operation = projectRecord(
      operation as unknown as RevisionRecord | CommentRecord
    ) as unknown as Record<string, unknown>
  }
  if (operation.record_type !== 'runme.operation') {
    throw new Error('Operation requires record_type runme.operation')
  }
  if (
    ![1, RUNME_OPERATION_LOG_FORMAT_VERSION].includes(
      operation.format_version as number
    )
  ) {
    throw new Error(
      `Unsupported operation format_version ${String(operation.format_version)}`
    )
  }
  if (
    typeof operation.actor_id !== 'string' ||
    operation.actor_id.length === 0 ||
    !Number.isSafeInteger(operation.actor_seq) ||
    (operation.actor_seq as number) <= 0 ||
    operation.op_id !== `${operation.actor_id}:${operation.actor_seq}`
  ) {
    throw new Error('Operation identity is invalid')
  }
  if (
    !Number.isSafeInteger(operation.lamport) ||
    (operation.lamport as number) <= 0
  ) {
    throw new Error(
      `Operation ${String(operation.op_id)} has an invalid Lamport value`
    )
  }
  if (
    !Array.isArray(operation.deps) ||
    operation.deps.some((dependency) => typeof dependency !== 'string') ||
    new Set(operation.deps as string[]).size !== operation.deps.length
  ) {
    throw new Error(
      `Operation ${String(operation.op_id)} has invalid dependencies`
    )
  }
  if (
    typeof operation.created_at !== 'string' ||
    operation.created_at.length === 0
  ) {
    throw new Error(`Operation ${String(operation.op_id)} requires created_at`)
  }
  if (typeof operation.kind !== 'string' || operation.kind.length === 0) {
    throw new Error(`Operation ${String(operation.op_id)} requires kind`)
  }
  if (!operation.payload || typeof operation.payload !== 'object') {
    throw new Error(
      `Operation ${String(operation.op_id)} requires an object payload`
    )
  }
  if (
    operation.kind === 'revision.checkpoint' ||
    operation.kind === 'comment.record'
  )
    validateRecordShape(
      serializedRecord(operation as unknown as RunmeOperation)
    )
  if (
    operation.transaction_id !== undefined &&
    (typeof operation.transaction_id !== 'string' ||
      operation.transaction_id.length === 0)
  ) {
    throw new Error(
      `Operation ${String(operation.op_id)} has invalid transaction_id`
    )
  }
  if (
    operation.suggestion_id !== undefined &&
    (typeof operation.suggestion_id !== 'string' ||
      operation.suggestion_id.length === 0)
  ) {
    throw new Error(
      `Operation ${String(operation.op_id)} has invalid suggestion_id`
    )
  }
  if (
    operation.reverts !== undefined &&
    (!Array.isArray(operation.reverts) ||
      operation.reverts.some((item) => typeof item !== 'string'))
  ) {
    throw new Error(`Operation ${String(operation.op_id)} has invalid reverts`)
  }
  return operation as unknown as RunmeOperation
}

export function parseOperationLog(text: string): ParsedOperationLog {
  if (!text.endsWith('\n')) {
    throw new Error('Operation log must end with LF')
  }
  const lines = text.slice(0, -1).split('\n')
  if (lines.length === 0 || lines[0].trim() === '') {
    throw new Error('Operation log is empty')
  }
  if (lines.some((line) => line.trim() === '')) {
    throw new Error('Operation log must not contain blank lines')
  }
  const values = lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown
    } catch (error) {
      throw new Error(
        `Invalid JSON on operation-log line ${index + 1}: ${String(error)}`
      )
    }
  })
  const header = validateHeader(values[0])
  const operations = values.slice(1).map((value) => {
    const record = requireObject(value, 'Operation')
    if (
      record.record_type === 'runme.operation' &&
      ['revision.checkpoint', 'comment.record'].includes(record.kind as string)
    )
      throw new Error(
        'Revision and comment entities must be serialized as first-class records'
      )
    return validateOperation(record)
  })
  if (operations.some((op) => op.format_version > header.format_version))
    throw new Error(
      'Record format exceeds notebook format; migrate the notebook explicitly'
    )
  operationMap(operations)
  validateLamportValues(operations)
  validateRecordReferences(operations)
  return { header, operations }
}

export function validateLamportValues(operations: RunmeOperation[]): void {
  const byId = operationMap(operations)
  for (const operation of operations) {
    const knownDependencies = operation.deps
      .map((dependency) => byId.get(dependency))
      .filter((dependency): dependency is RunmeOperation => Boolean(dependency))
    if (knownDependencies.length !== operation.deps.length) continue
    const expected =
      knownDependencies.length === 0
        ? 1
        : Math.max(
            ...knownDependencies.map((dependency) => dependency.lamport)
          ) + 1
    if (operation.lamport !== expected) {
      throw new Error(
        `Operation ${operation.op_id} has lamport ${operation.lamport}; expected ${expected}`
      )
    }
  }
}

/** V2 accepts V1 operations unchanged. Promote only the header so existing
 * notebook identity, operation IDs, revision boundaries and comments survive.
 * Call under the storage writer lock when saving an existing document.
 */
export function upgradeOperationLogToV2(document: string): string {
  const { header } = parseOperationLog(document)
  if (header.format_version === 2) return document
  const upgraded =
    canonicalJson({ ...header, format_version: 2 } as unknown as JsonValue) +
    document.slice(document.indexOf('\n'))
  parseOperationLog(upgraded)
  return upgraded
}

export function serializeOperationLog(
  header: NotebookLogHeader,
  operations: RunmeOperation[],
  options: { canonicalOrder?: boolean } = {}
): string {
  const validatedHeader = validateHeader(header)
  const validatedOperations = operations.map(validateOperation)
  if (
    validatedOperations.some(
      (op) => op.format_version > validatedHeader.format_version
    )
  )
    throw new Error(
      'Record format exceeds notebook format; migrate the notebook explicitly'
    )
  operationMap(validatedOperations)
  validateLamportValues(validatedOperations)
  validateRecordReferences(validatedOperations)
  const ordered = options.canonicalOrder
    ? (() => {
        const result = orderOperationSet(validatedOperations)
        return [...result.ordered, ...result.pending]
      })()
    : validatedOperations
  return [
    canonicalJson(validatedHeader as unknown as JsonValue),
    ...ordered.map((operation) => encodeOperation(operation)),
    '',
  ].join('\n')
}

/** Encode a single record for an append without leaking reducer-only fields. */
export function encodeOperation(operation: RunmeOperation): string {
  const record = serializedRecord(operation)
  if (record.record_type !== 'runme.operation') validateRecordShape(record)
  return canonicalJson(record as unknown as JsonValue)
}
