import { appLogger } from '../lib/logging/runtime'
import {
  type Active,
  type Control,
  type Selection,
  cacheName,
  releaseIdValid,
  releasePrefix,
  startupMarker,
  validateManifest,
  validateSelection,
} from './control'

export const PREFERENCES_CACHE = 'runme-release-preferences-v1'
const SAVED = '/__runme-release-preferences'
const OWNER = '/__runme-storage-target'
export type ReleaseReference = { releaseId: string; epoch: number }
export type Preferences = {
  format: 2
  revision: number
  // A distinct recovery generation supersedes an unreadable primary even if
  // it had an earlier recovery. Once mirrored to IDB, compare revisions normally.
  recoveryId?: string
  selection: Selection
  active?: ReleaseReference
  previous?: ReleaseReference
}

/** Manifests belong to immutable release caches, never to preference records. */
export function reference(active?: Active): ReleaseReference | undefined {
  return active && { releaseId: active.manifest.releaseId, epoch: active.epoch }
}
/** Project runtime state into the small record changed by explicit user actions. */
export function preferences(state: Control, revision: number): Preferences {
  return {
    format: 2,
    revision,
    selection: validateSelection(state.selection),
    active: reference(state.active),
    previous: reference(state.previous),
  }
}
/** Validate both IDB records and cached copies before using their references. */
export function validatePreferences(value: unknown): Preferences {
  const p = value as Preferences
  if (p?.format !== 2 || !Number.isSafeInteger(p.revision) || p.revision < 0)
    throw new Error('Invalid release preferences')
  if (
    p.recoveryId !== undefined &&
    (typeof p.recoveryId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        p.recoveryId
      ))
  )
    throw new Error('Invalid recovery preference marker')
  validateSelection(p.selection)
  for (const ref of [p.active, p.previous])
    if (
      ref &&
      (!releaseIdValid(ref.releaseId) ||
        !Number.isSafeInteger(ref.epoch) ||
        ref.epoch < 0)
    )
      throw new Error('Invalid installed release reference')
  return p
}
/** Resolve only completed, validated cache inventories; network access is unnecessary. */
export async function resolveReference(
  ref?: ReleaseReference
): Promise<Active | undefined> {
  if (!ref) return undefined
  const cache = await caches.open(cacheName(ref.releaseId))
  const response =
    (await cache.match(startupMarker(ref.releaseId))) ??
    (await cache.match(releasePrefix(ref.releaseId) + 'release.json'))
  if (!response)
    throw new Error('Installed release manifest is missing from cache')
  const manifest = validateManifest(await response.json())
  if (manifest.releaseId !== ref.releaseId)
    throw new Error('Cached release identity mismatch')
  return { manifest, epoch: ref.epoch }
}
/** Reconstruct the public version view without persisting manifests or tab state. */
export async function expandPreferences(p: Preferences): Promise<Control> {
  return {
    format: 1,
    selection: p.selection,
    tabs: {},
    active: await resolveReference(p.active),
    previous: await resolveReference(p.previous).catch(() => undefined),
  }
}
/** A cache-metadata stall must not hold up an otherwise healthy IDB read.
 * Read-only requests may finish late without changing any persisted selection.
 */
export async function readSavedPreferences(): Promise<Preferences | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const response = await (
          await caches.open(PREFERENCES_CACHE)
        ).match(SAVED)
        return response ? validatePreferences(await response.json()) : undefined
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Cached preference lookup timed out')),
          1500
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
/** This independent copy is updated only by explicit selection/activation, not by tabs opening. */
export async function savePreferences(p: Preferences): Promise<void> {
  await (await caches.open(PREFERENCES_CACHE)).put(SAVED, Response.json(p))
}
/** Read the storage generation independently of the selected app preferences. */
export async function readOwnerTarget(): Promise<Active | undefined> {
  const response = await (await caches.open(PREFERENCES_CACHE)).match(OWNER)
  if (!response) return undefined
  const ref = await response.json()
  validatePreferences({
    format: 2,
    revision: 0,
    selection: { kind: 'channel', name: 'stable' },
    active: ref,
  })
  return resolveReference(ref)
}
/** The selected storage generation changes only during an explicit activation.
 * The lifetime Web Lock, not this pointer, is the exclusive notebook writer gate.
 */
export async function selectOwnerTarget(active: Active): Promise<void> {
  await (
    await caches.open(PREFERENCES_CACHE)
  ).put(OWNER, Response.json(reference(active)))
}
/** Keep degraded-preference diagnostics outside the database that failed. */
export function reportPreferenceFallback(error: unknown): void {
  appLogger.warn(
    'Release preferences unavailable; using independent cached selection',
    {
      attrs: { scope: 'releases.preferences', error: String(error) },
    }
  )
}
