import { useEffect, useSyncExternalStore } from "react";

import { getAppConsoleData } from "./appConsoleController";
import type { AppConsoleSnapshot } from "./AppConsoleData";

export function useAppConsoleSnapshot(): AppConsoleSnapshot {
  const appConsoleData = getAppConsoleData();

  useEffect(() => {
    void appConsoleData.hydrate();
  }, [appConsoleData]);

  return useSyncExternalStore(
    (listener) => appConsoleData.subscribe(listener),
    () => appConsoleData.getSnapshot(),
    () => appConsoleData.getSnapshot(),
  );
}
