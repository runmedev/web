import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { appState } from "../lib/runtime/AppState";
import { appLogger } from "../lib/logging/runtime";

const STORAGE_KEY = "runme/workspace";
const LEGACY_STORAGE_KEY = "aisre/workspace";

export interface WorkspaceState {
  items: string[];
}

interface WorkspaceContextType {
  state: WorkspaceState;
  persistenceError?: string;
  addItem: (uri: string) => void;
  getItems: () => string[];
  removeItem: (uri: string) => void;
}

const WorkspaceContext = createContext<WorkspaceContextType | undefined>(
  undefined,
);

// eslint-disable-next-line react-refresh/only-export-components
export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider");
  }
  return context;
}

/** A failed read is not an empty workspace. Keep its original bytes untouched
 * until a later reload can read them, even if Explorer adds its default root.
 */
function loadWorkspaceState(): { state: WorkspaceState; canPersist: boolean } {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) ??
      localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) {
      return { state: { items: [] }, canPersist: true };
    }
    const parsed = JSON.parse(raw) as { items?: unknown };
    if (!parsed || !Array.isArray(parsed.items)) {
      throw new Error("Invalid saved workspace");
    }
    const normalized = parsed.items
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        if (entry && typeof entry === "object" && "uri" in entry) {
          const uri = (entry as { uri?: unknown }).uri;
          return typeof uri === "string" ? uri : null;
        }
        return null;
      })
      .filter((value): value is string => Boolean(value));
    if (normalized.length !== parsed.items.length) {
      throw new Error("Invalid saved workspace entry");
    }
    return { state: { items: normalized }, canPersist: true };
  } catch {
    appLogger.warn("Saved workspace could not be read; preserving stored state", {
      attrs: { scope: "storage.workspace", code: "WORKSPACE_READ_FAILED" },
    });
    return { state: { items: [] }, canPersist: false };
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(loadWorkspaceState);
  const [state, setState] = useState<WorkspaceState>(initial.state);

  useEffect(() => {
    if (!initial.canPersist) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      appLogger.warn("Failed to persist workspace state", {
        attrs: { scope: "storage.workspace", code: "WORKSPACE_WRITE_FAILED" },
      });
    }
  }, [initial.canPersist, state]);

  const addItem = useCallback((uri: string) => {
    setState((prev) => {
      if (prev.items.includes(uri)) {
        return prev;
      }
      return {
        items: [...prev.items, uri],
      };
    });
  }, []);

  const removeItem = useCallback((uri: string) => {
    setState((prev) => {
      const filtered = prev.items.filter((item) => item !== uri);
      if (filtered.length === prev.items.length) {
        return prev;
      }
      return { items: filtered };
    });
  }, []);

  const getItems = useCallback(
    () => [...state.items],
    [state.items],
  );

  const value = useMemo<WorkspaceContextType>(
    () => ({
      state,
      persistenceError: initial.canPersist ? undefined :
        "Saved folders could not be read. Folder changes in this tab will not be saved. Reload to retry; stored data has been kept.",
      addItem,
      getItems,
      removeItem,
    }),
    [state, initial.canPersist, addItem, getItems, removeItem],
  );

  useEffect(() => {
    appState.setWorkspaceHandlers({
      getItems,
      addItem,
      removeItem,
    });
    return () => {
      appState.setWorkspaceHandlers(null);
    };
  }, [addItem, getItems, removeItem]);

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}
