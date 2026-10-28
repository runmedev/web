import { releaseIdValid } from './control'

/** Discover published builds without opening release settings or notebook storage. */
export async function publishedReleaseIds(): Promise<string[]> {
  const response = await fetch('/releases/catalog.json', {
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok)
    throw new Error(
      'Published releases are unavailable. Try an exact release ID.'
    )
  const catalog = await response.json()
  if (catalog.format !== 1 || !Array.isArray(catalog.releases))
    throw new Error('Unsupported release catalog')
  return [
    ...new Set<string>(
      catalog.releases
        .map((release: { releaseId?: unknown }) => release?.releaseId)
        .filter(releaseIdValid)
    ),
  ].reverse()
}

/** A commit may have multiple builds; never guess between distinct matches. */
export async function resolvePublishedRelease(input: string): Promise<string> {
  const value = input.trim().toLowerCase()
  if (releaseIdValid(value)) return value
  if (!/^[a-f0-9]{7,40}$/.test(value))
    throw new Error(
      'Enter a commit SHA (at least 7 characters) or a full release ID.'
    )
  const matches = (await publishedReleaseIds()).filter((id) =>
    id.slice(0, 40).startsWith(value)
  )
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? 'Multiple builds match this commit. Browse published releases and select an exact release ID.'
        : 'No published release matches this commit.'
    )
  return matches[0]
}
