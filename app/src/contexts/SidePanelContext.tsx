import {
  createContext,
  ReactNode,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";

import { type PanelKey, tourUiController } from "../lib/tourUiController";

export type { PanelKey } from "../lib/tourUiController";

interface SidePanelContextValue {
  activePanel: PanelKey;
  togglePanel: (panel: Exclude<PanelKey, null>) => void;
  setPanel: (panel: PanelKey) => void;
}

const SidePanelContext = createContext<SidePanelContextValue | undefined>(
  undefined,
);

export function SidePanelProvider({ children }: { children: ReactNode }) {
  const activePanel = useSyncExternalStore(
    tourUiController.subscribe,
    () => tourUiController.getSnapshot().activePanel,
    () => tourUiController.getSnapshot().activePanel,
  );

  const value = useMemo(
    () => ({
      activePanel,
      togglePanel: tourUiController.toggleActivePanel,
      setPanel: tourUiController.setActivePanel,
    }),
    [activePanel],
  );

  return (
    <SidePanelContext.Provider value={value}>
      {children}
    </SidePanelContext.Provider>
  );
}

export function useSidePanel() {
  const ctx = useContext(SidePanelContext);
  if (!ctx) {
    throw new Error("useSidePanel must be used within a SidePanelProvider");
  }
  return ctx;
}
