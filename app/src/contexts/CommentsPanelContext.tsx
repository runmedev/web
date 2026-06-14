import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'

interface CommentsPanelContextValue {
  commentsPanelOpen: boolean
  setCommentsPanelOpen: (open: boolean) => void
  openCommentsPanel: () => void
  toggleCommentsPanel: () => void
}

const STORAGE_KEY = 'runme.commentsPanel.open'

const CommentsPanelContext = createContext<
  CommentsPanelContextValue | undefined
>(undefined)

export function CommentsPanelProvider({ children }: { children: ReactNode }) {
  const [commentsPanelOpen, setCommentsPanelOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return false
    }
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true'
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, commentsPanelOpen ? 'true' : 'false')
    } catch {
      // Non-critical preference persistence.
    }
  }, [commentsPanelOpen])

  const openCommentsPanel = useCallback(() => {
    setCommentsPanelOpen(true)
  }, [])

  const toggleCommentsPanel = useCallback(() => {
    setCommentsPanelOpen((open) => !open)
  }, [])

  const value = useMemo(
    () => ({
      commentsPanelOpen,
      setCommentsPanelOpen,
      openCommentsPanel,
      toggleCommentsPanel,
    }),
    [commentsPanelOpen, openCommentsPanel, toggleCommentsPanel]
  )

  return (
    <CommentsPanelContext.Provider value={value}>
      {children}
    </CommentsPanelContext.Provider>
  )
}

export function useCommentsPanel() {
  const ctx = useContext(CommentsPanelContext)
  if (!ctx) {
    throw new Error(
      'useCommentsPanel must be used within a CommentsPanelProvider'
    )
  }
  return ctx
}
