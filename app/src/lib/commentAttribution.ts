import type { DriveUser } from '../storage/drive'

/** Describe recorded attribution without presenting caller labels as verified identity. */
export function commentAttributionLabel(author?: DriveUser): string {
  if (!author?.runmeAuthorKind) return '' // Preserve legacy/provider labels.
  if (
    author.runmeAuthorSource === 'google-drive' &&
    author.runmeAuthenticatedPrincipal
  )
    return `${author.runmeAuthorKind === 'service-account' ? 'service account' : author.runmeAuthorKind} · Google Drive identity`
  return author.runmeAuthorKind === 'unknown'
    ? 'unknown'
    : `${author.runmeAuthorKind === 'service-account' ? 'service account' : author.runmeAuthorKind} · supplied attribution`
}
