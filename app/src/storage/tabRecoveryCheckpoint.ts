import type { parser_pb } from '../runme/client'
import {
  type EditorSaveCheckpoint,
  EditorSaveSession,
} from './editorSaveSession'

const KEY = 'runme/tab-editor-recovery/v1'
type Envelope = { format: 1; editors: EditorSaveCheckpoint[] }

/** Fail closed on unknown formats or corrupt data; leave the original bytes intact. */
export function readTabCheckpoints(uri?: string): EditorSaveCheckpoint[] {
  const raw = sessionStorage.getItem(KEY)
  if (!raw) return []
  const value = JSON.parse(raw) as Envelope
  if (value?.format !== 1 || !Array.isArray(value.editors))
    throw new Error(
      'Unsupported tab recovery format; keep this tab’s recovery data'
    )
  const entries =
    uri === undefined
      ? value.editors
      : value.editors.filter((entry) => entry?.uri === uri)
  const uris = new Set<string>()
  for (const entry of entries) {
    if (typeof entry?.uri !== 'string' || uris.has(entry.uri))
      throw new Error('Invalid tab recovery notebook identity')
    uris.add(entry.uri)
    // Validate all editor state before returning any entry for restoration.
    new EditorSaveSession(
      entry.uri,
      entry.document,
      async () => {},
      entry.actorId,
      entry
    )
  }
  return entries
}

/** Enumerate identities without letting a damaged editor block unrelated loads.
 * Each notebook validates its own checkpoint when it opens; bytes stay intact.
 */
export function tabCheckpointUris(): string[] {
  const raw = sessionStorage.getItem(KEY)
  if (!raw) return []
  const value = JSON.parse(raw) as Envelope
  if (value?.format !== 1 || !Array.isArray(value.editors))
    throw new Error(
      'Unsupported tab recovery format; keep this tab’s recovery data'
    )
  return [
    ...new Set(
      value.editors
        .map((entry) => entry?.uri)
        .filter((uri) => typeof uri === 'string')
    ),
  ]
}

/** Synchronous write/read-back is the reload boundary, independent of the worker.
 * Keep unconsumed entries, including saves from editors closed before recovery.
 */
export function writeTabCheckpoints(entries: EditorSaveCheckpoint[]): void {
  const retained = new Map(
    readTabCheckpoints().map((entry) => [entry.uri, entry])
  )
  const captured = new Set<string>()
  for (const entry of entries) {
    if (captured.has(entry.uri))
      throw new Error(
        'Multiple pending editors for one notebook; reconnect saves before reloading this tab'
      )
    captured.add(entry.uri)
    retained.set(entry.uri, entry)
  }
  const raw = JSON.stringify({
    format: 1,
    editors: [...retained.values()],
  } satisfies Envelope)
  sessionStorage.setItem(KEY, raw)
  if (sessionStorage.getItem(KEY) !== raw)
    throw new Error(
      'Tab recovery checkpoint could not be verified; no reload performed'
    )
  readTabCheckpoints()
}

/** Clear only after replay and the restored editor snapshot have been acknowledged. */
export function acknowledgeTabCheckpoint(uri: string, actorId: string): void {
  const entries = readTabCheckpoints()
  const remaining = entries.filter(
    (entry) => entry.uri !== uri || entry.actorId !== actorId
  )
  if (remaining.length === entries.length) return
  if (!remaining.length) sessionStorage.removeItem(KEY)
  else
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ format: 1, editors: remaining } satisfies Envelope)
    )
}

type CheckpointTransport = {
  uris: () => ReadonlySet<string>
  capture: (
    editors: Map<string, parser_pb.Notebook>
  ) => Promise<EditorSaveCheckpoint[]>
  resume: () => void
}
let transport: CheckpointTransport | undefined

/** The storage adapter owns save sessions; preparation owns the visible editors. */
export function registerCheckpointTransport(value: CheckpointTransport): void {
  transport = value
}

/** Legacy snapshot stores must acknowledge a durable flush before local reload. */
export function checkpointEditorUris(): ReadonlySet<string> {
  return transport?.uris() ?? new Set()
}

export async function checkpointEditorSessions(
  editors: Map<string, parser_pb.Notebook>,
  signal?: AbortSignal
): Promise<Set<string>> {
  if (!transport) throw new Error('Editor recovery transport is not ready')
  const checkpoints = await transport.capture(editors)
  signal?.throwIfAborted()
  writeTabCheckpoints(checkpoints)
  return new Set(checkpoints.map((entry) => entry.uri))
}

export function resumeCheckpointTransport(): void {
  transport?.resume()
}
