/**
 * App Console snippets behind UI affordances. Each builder returns JavaScript
 * source that `useAppConsoleRunner().createAndRun` records and runs in the App
 * Console, so users see (and can copy or edit) the exact helper calls a menu
 * item performs.
 */

/**
 * Lists the Google Drive revisions of the notebook with the given local URI.
 *
 * `notebooks.open` loads the notebook without changing which tab is focused
 * (the helpers below only resolve notebooks that are open). The URI is encoded
 * with JSON.stringify so quotes or other characters in it cannot break out of
 * the string literal.
 */
export function buildListDriveRevisionsSnippet(localUri: string): string {
  const uri = JSON.stringify(localUri)
  return [
    `await notebooks.open(${uri})`,
    `await notebookDiff.listDriveRevisions({ uri: ${uri} })`,
  ].join('\n')
}
