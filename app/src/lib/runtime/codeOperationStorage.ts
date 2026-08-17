import Dexie, { type Table } from 'dexie'

import type {
  ExecuteCodeOperationRecord,
  ExecuteCodeOutputEvent,
} from './codeOperationTypes'
import { isExecuteCodeOperationTerminal } from './codeOperationTypes'

export interface CodeOperationStorageLike {
  initialize(sessionId: string): Promise<void>
  getOperation(operationId: string): Promise<ExecuteCodeOperationRecord | null>
  findByIdempotencyKey(
    sessionId: string,
    idempotencyKey: string
  ): Promise<ExecuteCodeOperationRecord | null>
  putOperation(record: ExecuteCodeOperationRecord): Promise<void>
  appendOutputEvent(event: ExecuteCodeOutputEvent): Promise<void>
  getOutputEvents(operationId: string): Promise<ExecuteCodeOutputEvent[]>
}

class CodeOperationDatabase extends Dexie implements CodeOperationStorageLike {
  operations!: Table<ExecuteCodeOperationRecord, string>
  outputEvents!: Table<ExecuteCodeOutputEvent, [string, number]>

  constructor(databaseName = 'runme-code-operations') {
    super(databaseName)

    this.version(1).stores({
      operations:
        '&id, sessionId, status, updatedAt, expiresAt, [sessionId+idempotencyKey]',
      outputEvents: '[operationId+sequence], operationId, createdAt',
    })

    this.operations = this.table('operations')
    this.outputEvents = this.table('outputEvents')
  }

  async initialize(sessionId: string): Promise<void> {
    const now = new Date().toISOString()
    const records = await this.operations
      .where('sessionId')
      .equals(sessionId)
      .toArray()
    const updates: ExecuteCodeOperationRecord[] = []

    for (const record of records) {
      if (!isExecuteCodeOperationTerminal(record.status)) {
        updates.push({
          ...record,
          status: 'interrupted',
          updatedAt: now,
          completedAt: now,
          error: {
            code: 'PAGE_RELOADED',
            message:
              'ExecuteCode was interrupted when the Runme page reloaded.',
            downstreamMayContinue: true,
          },
        })
        continue
      }
      if (record.status !== 'expired' && record.expiresAt <= now) {
        updates.push({
          ...record,
          status: 'expired',
          updatedAt: now,
        })
      }
    }

    if (updates.length > 0) {
      await this.operations.bulkPut(updates)
    }
  }

  async getOperation(
    operationId: string
  ): Promise<ExecuteCodeOperationRecord | null> {
    return (await this.operations.get(operationId)) ?? null
  }

  async findByIdempotencyKey(
    sessionId: string,
    idempotencyKey: string
  ): Promise<ExecuteCodeOperationRecord | null> {
    return (
      (await this.operations
        .where('[sessionId+idempotencyKey]')
        .equals([sessionId, idempotencyKey])
        .first()) ?? null
    )
  }

  async putOperation(record: ExecuteCodeOperationRecord): Promise<void> {
    await this.operations.put(record)
  }

  async appendOutputEvent(event: ExecuteCodeOutputEvent): Promise<void> {
    await this.outputEvents.put(event)
  }

  async getOutputEvents(
    operationId: string
  ): Promise<ExecuteCodeOutputEvent[]> {
    return this.outputEvents
      .where('operationId')
      .equals(operationId)
      .sortBy('sequence')
  }
}

export const codeOperationStorage: CodeOperationStorageLike =
  new CodeOperationDatabase()
