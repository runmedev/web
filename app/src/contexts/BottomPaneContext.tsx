import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'

export type BottomPaneTab = 'console' | 'logs'

interface BottomPaneContextValue {
  activeTab: BottomPaneTab
  collapsed: boolean
  commandsPanelOpen: boolean
  setActiveTab: (tab: BottomPaneTab) => void
  setCollapsed: (collapsed: boolean) => void
  toggleCollapsed: () => void
  toggleCommandsPanel: () => void
}

const STORAGE_KEY = 'runme.bottomPaneCollapsed'
const LEGACY_STORAGE_KEY = 'aisre.bottomPaneCollapsed'

const BottomPaneContext = createContext<BottomPaneContextValue | undefined>(
  undefined
)

export function BottomPaneProvider({ children }: { children: ReactNode }) {
  const [activeTab, setActiveTab] = useState<BottomPaneTab>('console')
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return false
    }
    try {
      const stored =
        localStorage.getItem(STORAGE_KEY) ??
        localStorage.getItem(LEGACY_STORAGE_KEY)
      return stored === 'true'
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? 'true' : 'false')
      localStorage.removeItem(LEGACY_STORAGE_KEY)
    } catch {
      // Non-critical preference persistence.
    }
  }, [collapsed])

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev)
  }, [])

  const toggleCommandsPanel = useCallback(() => {
    const shouldCollapse = activeTab === 'console' && !collapsed
    setActiveTab('console')
    setCollapsed(shouldCollapse)
  }, [activeTab, collapsed])

  const value = useMemo(
    () => ({
      activeTab,
      collapsed,
      commandsPanelOpen: activeTab === 'console' && !collapsed,
      setActiveTab,
      setCollapsed,
      toggleCollapsed,
      toggleCommandsPanel,
    }),
    [activeTab, collapsed, toggleCollapsed, toggleCommandsPanel]
  )

  return (
    <BottomPaneContext.Provider value={value}>
      {children}
    </BottomPaneContext.Provider>
  )
}

export function useBottomPane() {
  const ctx = useContext(BottomPaneContext)
  if (!ctx) {
    throw new Error('useBottomPane must be used within a BottomPaneProvider')
  }
  return ctx
}
