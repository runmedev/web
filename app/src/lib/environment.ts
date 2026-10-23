/** User variables have their own namespace, separate from Runme settings. */
export const ENVIRONMENT_PREFIX = 'runme.env.'

export type EnvironmentVariable = { name: string; value: string }

/** Read persisted strings on demand so browser JS edits are visible on refresh. */
export function listEnvironmentVariables(): EnvironmentVariable[] {
  const storage = window.localStorage
  const variables: EnvironmentVariable[] = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key?.startsWith(ENVIRONMENT_PREFIX)) {
      variables.push({
        name: key.slice(ENVIRONMENT_PREFIX.length),
        value: storage.getItem(key) ?? '',
      })
    }
  }
  return variables.sort((a, b) => a.name.localeCompare(b.name))
}

/** Add or update one variable without rewriting other localStorage entries. */
export function saveEnvironmentVariable(
  name: string,
  value: string,
  create: boolean
): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      'Use letters, numbers, and underscores; start with a letter or underscore.'
    )
  }
  const key = ENVIRONMENT_PREFIX + name
  if (create && window.localStorage.getItem(key) !== null) {
    throw new Error(
      'This variable already exists. Use Edit to change its value.'
    )
  }
  window.localStorage.setItem(key, value)
}

/** Remove only the selected user variable. Storage failures reach the UI. */
export function removeEnvironmentVariable(name: string): void {
  window.localStorage.removeItem(ENVIRONMENT_PREFIX + name)
}
