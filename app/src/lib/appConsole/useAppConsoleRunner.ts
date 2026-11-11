import { useCallback } from 'react'

import { useCurrentDoc } from '../../contexts/CurrentDocContext'
import { useWorkspaceDocumentContext } from '../../contexts/WorkspaceDocumentContext'
import { APP_CONSOLE_DOCUMENT_URI } from '../workspaceDocuments/workspaceDocumentTypes'
import { getAppConsoleData } from './appConsoleController'

/**
 * Returns `createAndRun(code)`, which lets a UI affordance (for example a
 * context menu item) run a JavaScript snippet in the App Console.
 *
 * The snippet is recorded as a new History cell, so the user can see it, re-run
 * it, or copy it back to the draft. The user's in-progress draft is preserved.
 * The App Console tab is opened and focused if it is not already visible; the
 * console view executes the queued snippet as soon as it is mounted.
 *
 * State flow: this hook only queues the request on the shared `AppConsoleData`
 * model and switches tabs through the document contexts. Execution itself stays
 * in the `AppConsole` component because it owns the runtime globals.
 */
export function useAppConsoleRunner(): {
  createAndRun: (code: string) => void
} {
  const { showDocument } = useWorkspaceDocumentContext()
  const { setCurrentDoc } = useCurrentDoc()

  const createAndRun = useCallback(
    (code: string) => {
      if (code.trim() === '') {
        return
      }
      // Queue first: if the console tab is already mounted it starts right
      // away; otherwise it picks the request up when showDocument mounts it.
      getAppConsoleData().requestRun(code)
      showDocument(APP_CONSOLE_DOCUMENT_URI, { title: 'App Console' })
      setCurrentDoc(APP_CONSOLE_DOCUMENT_URI)
    },
    [setCurrentDoc, showDocument]
  )

  return { createAndRun }
}
