/** Tab database connections register here so handoff closes readers without
 * importing their modules (which could itself initialize more storage).
 */
const databases = new Set<{ close(): void }>()
export function registerReleaseDatabase(db: { close(): void }): void {
  databases.add(db)
}
export function closeReleaseDatabases(): void {
  for (const db of databases) db.close()
}
