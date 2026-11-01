import {
  getStorageWorkerStatus,
  listStorageWorkerSessions,
  readStorageWorkerLogs,
} from '../../storage/workerDiagnostics'
import type { WorkerLogQuery } from '../../storage/workerLog'
import type { RegisteredAppTool } from './desktopTools'

/** Validate direct tool calls before entering browser APIs; schemas alone are not
 * an execution boundary for desktop callers or JavaScript test harnesses.
 */
function options(input: Record<string, unknown>, requireInstance: boolean) {
  const result: WorkerLogQuery & { instanceId: string; timeoutMs?: number } = {
    instanceId: '',
  }
  if (
    requireInstance &&
    (typeof input.instanceId !== 'string' ||
      !/^[\w-]{1,200}$/.test(input.instanceId))
  )
    throw new Error(
      'A worker instanceId from ListStorageWorkerSessions is required'
    )
  if (typeof input.instanceId === 'string') result.instanceId = input.instanceId
  for (const key of [
    'afterSequence',
    'limit',
    'maxBytes',
    'timeoutMs',
  ] as const) {
    if (input[key] === undefined) continue
    if (
      typeof input[key] !== 'number' ||
      !Number.isSafeInteger(input[key]) ||
      input[key] < 0
    )
      throw new Error(`Invalid ${key}`)
    result[key] = input[key]
  }
  for (const key of ['scope', 'requestId'] as const) {
    if (input[key] === undefined) continue
    if (typeof input[key] !== 'string' || input[key].length > 200)
      throw new Error(`Invalid ${key}`)
    result[key] = input[key]
  }
  if (input.minLevel !== undefined) {
    if (!['debug', 'info', 'warn', 'error'].includes(String(input.minLevel)))
      throw new Error('Invalid minLevel')
    result.minLevel = input.minLevel as WorkerLogQuery['minLevel']
  }
  return result
}

/** Read-only handlers intentionally bypass console history, the code-operation
 * registry, notebook RPC and release settings. Register with the app shell.
 */
export function storageWorkerTools(): RegisteredAppTool[] {
  const properties = {
    instanceId: { type: 'string', minLength: 1, maxLength: 200 },
    timeoutMs: { type: 'integer', minimum: 100, maximum: 5000 },
    afterSequence: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    maxBytes: { type: 'integer', minimum: 16384, maximum: 262144 },
    minLevel: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
    scope: { type: 'string', maxLength: 200 },
    requestId: { type: 'string', maxLength: 200 },
  }
  return [
    {
      name: 'ListStorageWorkerSessions',
      title: 'List Storage Worker Sessions',
      description:
        'Discover responding storage workers and persisted log sessions for this origin/profile. Partial discovery is explicit; no reply does not prove termination.',
      fields: { timeoutMs: properties.timeoutMs },
      required: [],
      run: (input: Record<string, unknown>) =>
        listStorageWorkerSessions(options(input, false)),
    },
    {
      name: 'GetStorageWorkerStatus',
      title: 'Get Storage Worker Status',
      description:
        'Read one worker’s phase and diagnostics over its early control channel, independent of notebook initialization and IndexedDB. A timeout means unknown.',
      fields: {
        instanceId: properties.instanceId,
        timeoutMs: properties.timeoutMs,
      },
      required: ['instanceId'],
      run: (input: Record<string, unknown>) =>
        getStorageWorkerStatus(options(input, true)),
    },
    {
      name: 'ReadStorageWorkerLogs',
      title: 'Read Storage Worker Logs',
      description:
        'Read a bounded page of live memory and persisted OPFS worker logs. Returns source failures, gaps and pagination; does not initialize notebook storage, execute code or restart a worker.',
      fields: properties,
      required: ['instanceId'],
      run: (input: Record<string, unknown>) =>
        readStorageWorkerLogs(options(input, true)),
    },
  ].map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: tool.fields,
      required: tool.required,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (input) => JSON.stringify(await tool.run(input)),
  }))
}
