import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from "react";

type PanelKey = "explorer" | "chatkit" | "settings" | null;

interface SidePanelContextValue {
  activePanel: PanelKey;
  togglePanel: (panel: Exclude<PanelKey, null>) => void;
  setPanel: (panel: PanelKey) => void;
}

const STORAGE_KEY = "runme.sidePanel.active";
const LEGACY_STORAGE_KEY = "aisre.sidePanel.active";

const SidePanelContext = createContext<SidePanelContextValue | undefined>(undefined);

export function SidePanelProvider({ children }: { children: ReactNode }) {
  const [activePanel, setActivePanel] = useState<PanelKey>(() => {
    if (typeof window === "undefined") {
      return "explorer";
    }
    try {
      const stored =
        localStorage.getItem(STORAGE_KEY) ??
        localStorage.getItem(LEGACY_STORAGE_KEY);
      if (stored === "explorer" || stored === "chatkit" || stored === "settings") {
        return stored;
      }
    } catch (error) {
      console.error("Failed to read side panel state", error);
    }
    return "explorer";
  });

  useEffect(() => {
    try {
      if (activePanel) {
        localStorage.setItem(STORAGE_KEY, activePanel);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      } else {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    } catch (error) {
      console.error("Failed to persist side panel state", error);
    }
  }, [activePanel]);

  const value = useMemo(
    () => ({
      activePanel,
      togglePanel: (panel: Exclude<PanelKey, null>) => {
        setActivePanel((prev) => (prev === panel ? null : panel));
      },
      setPanel: setActivePanel,
    }),
    [activePanel],
  );

  return <SidePanelContext.Provider value={value}>{children}</SidePanelContext.Provider>;
}

export function useSidePanel() {
  const ctx = useContext(SidePanelContext);
  if (!ctx) {
    throw new Error("useSidePanel must be used within a SidePanelProvider");
  }
  return ctx;
}
