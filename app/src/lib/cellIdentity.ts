import type { parser_pb } from '../runme/client'

export const LEGACY_IPYNB_CELL_ID_METADATA_KEY = 'runme.dev/ipynbCellId'

const CELL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export type CellIdentityMigration = {
  changed: boolean
}

export function isCanonicalCellId(value: unknown): value is string {
  return typeof value === 'string' && CELL_ID_PATTERN.test(value)
}

export function uniqueCanonicalCellId(
  value: unknown,
  index: number,
  used: Set<string>
): string {
  const fallback = `cell-${index + 1}`
  const base = legalCellId(value, fallback)
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) {
    const tail = `-${suffix++}`
    candidate = `${base.slice(0, 64 - tail.length)}${tail}`
  }
  used.add(candidate)
  return candidate
}

/**
 * Migrates legacy notebook identities in place. `preferredIdsByRefId` is used
 * when an older IPYNB preservation record still maps a kind-prefixed Runme ID
 * to the canonical Jupyter cell ID.
 */
export function migrateNotebookCellIds(
  notebook: parser_pb.Notebook,
  preferredIdsByRefId: Record<string, string> = {}
): CellIdentityMigration {
  const used = new Set<string>()
  let changed = false

  notebook.cells.forEach((cell, index) => {
    const legacyIpynbId = cell.metadata[LEGACY_IPYNB_CELL_ID_METADATA_KEY]
    if (LEGACY_IPYNB_CELL_ID_METADATA_KEY in cell.metadata) {
      delete cell.metadata[LEGACY_IPYNB_CELL_ID_METADATA_KEY]
      changed = true
    }
    const current = cell.refId
    const legacyMetadataId = cell.metadata['runme.dev/id']
    const original =
      current ||
      (typeof legacyMetadataId === 'string' ? legacyMetadataId.trim() : '')
    const metadataIpynbId =
      typeof legacyIpynbId === 'string' &&
      (current === `code_${legacyIpynbId}` ||
        current === `markup_${legacyIpynbId}`)
        ? legacyIpynbId
        : undefined
    const preferred =
      preferredIdsByRefId[current] ?? metadataIpynbId ?? original
    const canonical = uniqueCanonicalCellId(preferred, index, used)

    if (canonical === current) {
      return
    }

    changed = true
    cell.refId = canonical
  })

  return { changed }
}

export function assertCanonicalNotebookCellIds(
  notebook: parser_pb.Notebook
): void {
  const used = new Set<string>()
  notebook.cells.forEach((cell, index) => {
    if (!isCanonicalCellId(cell.refId)) {
      throw new Error(
        `Cell ${index + 1} has an invalid canonical refId: ${JSON.stringify(cell.refId)}`
      )
    }
    if (used.has(cell.refId)) {
      throw new Error(`Duplicate canonical cell refId: ${cell.refId}`)
    }
    used.add(cell.refId)
  })
}

function legalCellId(value: unknown, fallback: string): string {
  const candidate =
    typeof value === 'string'
      ? value.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64)
      : ''
  return candidate || fallback.slice(0, 64)
}
