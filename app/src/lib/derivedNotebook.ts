/** Portable notebook metadata shared by the exporter, model and views. */
export const AUTO_IPYNB_KEY = 'runme.dev/autoIpynb'
export const DERIVED_NOTEBOOK_KEY = 'runme.dev/derivedFrom'

export interface DerivedNotebookSource {
  version: 1
  uri: string
  notebookId: string
  generatedAt: string
}

/** Accept only supported provenance with a safe, navigable source URI. */
export function parseDerivedSource(
  value: unknown
): DerivedNotebookSource | null {
  try {
    const source = typeof value === 'string' ? JSON.parse(value) : value
    if (
      !source ||
      source.version !== 1 ||
      typeof source.uri !== 'string' ||
      typeof source.notebookId !== 'string' ||
      typeof source.generatedAt !== 'string'
    )
      return null
    const url = new URL(source.uri)
    if (
      !(
        url.protocol === 'https:' &&
        url.hostname === 'drive.google.com' &&
        url.pathname.startsWith('/file/d/')
      )
    )
      return null
    return source as DerivedNotebookSource
  } catch {
    return null
  }
}
