import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react'

import { getNotebookSessionPersistence } from '../lib/notebookSessionPersistence'
import {
  isNotebookDocumentUri,
  isRestorableWorkspaceDocument,
} from '../lib/workspaceDocuments/workspaceDocumentTypes'

interface CurrentDocContextValue {
  getCurrentDoc: () => string | null
  getLastNotebookDoc: () => string | null
  setCurrentDoc: (uri: string | null) => void
}

const CurrentDocContext = createContext<CurrentDocContextValue | undefined>(
  undefined
)

function loadRestorableStoredCurrentDoc(): string | null {
  const uri = getNotebookSessionPersistence().loadCurrentDoc()
  return uri && isRestorableWorkspaceDocument(uri) ? uri : null
}

export function useCurrentDoc() {
  const ctx = useContext(CurrentDocContext)
  if (!ctx) {
    throw new Error('useCurrentDoc must be used within a CurrentDocProvider')
  }
  return ctx
}

export function CurrentDocProvider({ children }: { children: ReactNode }) {
  const [currentDoc, setCurrentDocState] = useState<string | null>(
    loadRestorableStoredCurrentDoc
  )
  const [lastNotebookDoc, setLastNotebookDocState] = useState<string | null>(
    () => {
      const uri = loadRestorableStoredCurrentDoc()
      return isNotebookDocumentUri(uri) ? uri : null
    }
  )

  const getCurrentDoc = useCallback(() => {
    return currentDoc
  }, [currentDoc])

  const getLastNotebookDoc = useCallback(() => {
    return lastNotebookDoc
  }, [lastNotebookDoc])

  const setCurrentDoc = useCallback(
    (localUri: string | null) => {
      if (currentDoc === localUri) {
        return
      }
      if (isNotebookDocumentUri(localUri)) {
        setLastNotebookDocState((prev) => {
          if (prev === localUri) {
            return prev
          }
          return localUri
        })
      }
      // Avoid no-op updates that can trigger unnecessary renders.
      setCurrentDocState((prev) => {
        if (prev === localUri) {
          return prev
        }
        return localUri
      })

      getNotebookSessionPersistence().saveCurrentDoc(
        localUri && isRestorableWorkspaceDocument(localUri) ? localUri : null
      )
    },
    [currentDoc]
  )

  const value = useMemo<CurrentDocContextValue>(
    () => ({
      getCurrentDoc,
      getLastNotebookDoc,
      setCurrentDoc,
    }),
    [getCurrentDoc, getLastNotebookDoc, setCurrentDoc]
  )

  return (
    <CurrentDocContext.Provider value={value}>
      {children}
    </CurrentDocContext.Provider>
  )
}
