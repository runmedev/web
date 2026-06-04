import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react'

import { useCurrentDoc } from './CurrentDocContext'
import { useNotebookContext } from './NotebookContext'
import {
  WORKSPACE_DOCUMENT_FOCUS_EVENT,
  getWorkspaceDocumentController,
  type ShowWorkspaceDocumentOptions,
  type WorkspaceDocumentFocusEventDetail,
} from '../lib/workspaceDocuments/workspaceDocumentController'
import {
  isNotebookDocumentUri,
  type WorkspaceDocument,
} from '../lib/workspaceDocuments/workspaceDocumentTypes'

type WorkspaceDocumentContextValue = {
  useWorkspaceDocuments: () => WorkspaceDocument[]
  showDocument: (uri: string, options?: ShowWorkspaceDocumentOptions) => void
  closeWorkspaceDocument: (uri: string) => string | null
}

const WorkspaceDocumentContext = createContext<
  WorkspaceDocumentContextValue | undefined
>(undefined)

export function useWorkspaceDocumentContext() {
  const ctx = useContext(WorkspaceDocumentContext)
  if (!ctx) {
    throw new Error(
      'useWorkspaceDocumentContext must be used within a WorkspaceDocumentProvider'
    )
  }
  return ctx
}

export function WorkspaceDocumentProvider({
  children,
}: {
  children: ReactNode
}) {
  const controller = getWorkspaceDocumentController()
  const { useNotebookList, removeNotebook } = useNotebookContext()
  const openNotebooks = useNotebookList()
  const { getCurrentDoc, setCurrentDoc } = useCurrentDoc()

  useEffect(() => {
    for (const notebook of openNotebooks) {
      controller.showDocument(notebook.uri, {
        title: notebook.name,
        requestedUri: notebook.requestedUri,
        state: notebook.state,
        errorMessage: notebook.errorMessage,
        owner: notebook.owner,
      })
    }
  }, [controller, openNotebooks])

  const showDocument = useCallback(
    (uri: string, options?: ShowWorkspaceDocumentOptions) => {
      controller.showDocument(uri, options)
    },
    [controller]
  )

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const handleFocusRequest = (event: Event) => {
      const uri = (event as CustomEvent<WorkspaceDocumentFocusEventDetail>)
        .detail?.uri
      if (typeof uri === 'string' && uri.trim()) {
        setCurrentDoc(uri)
      }
    }
    window.addEventListener(WORKSPACE_DOCUMENT_FOCUS_EVENT, handleFocusRequest)
    return () => {
      window.removeEventListener(
        WORKSPACE_DOCUMENT_FOCUS_EVENT,
        handleFocusRequest
      )
    }
  }, [setCurrentDoc])

  const closeWorkspaceDocument = useCallback(
    (uri: string) => {
      const fallback = controller.closeDocument(uri)
      if (isNotebookDocumentUri(uri)) {
        removeNotebook(uri)
      }
      if (getCurrentDoc() === uri) {
        setCurrentDoc(fallback)
      }
      return fallback
    },
    [controller, getCurrentDoc, removeNotebook, setCurrentDoc]
  )

  const useWorkspaceDocuments = useCallback(() => {
    const subscribe = useCallback(
      (listener: () => void) => controller.subscribe(listener),
      [controller]
    )
    const getSnapshot = useCallback(
      () => controller.getSnapshot().documents,
      [controller]
    )
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  }, [controller])

  const value = useMemo<WorkspaceDocumentContextValue>(
    () => ({
      useWorkspaceDocuments,
      showDocument,
      closeWorkspaceDocument,
    }),
    [closeWorkspaceDocument, showDocument, useWorkspaceDocuments]
  )

  return (
    <WorkspaceDocumentContext.Provider value={value}>
      {children}
    </WorkspaceDocumentContext.Provider>
  )
}
