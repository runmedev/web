import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

const STORAGE_KEY = "aisre/workspace";

export interface WorkspaceState {
  items: string[];
}

interface WorkspaceContextType {
  state: WorkspaceState;
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

function loadWorkspaceState(): WorkspaceState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { items: [] };
    }
    const parsed = JSON.parse(raw) as { items?: unknown };
    if (!parsed || !Array.isArray(parsed.items)) {
      return { items: [] };
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
    return { items: normalized };
  } catch (error) {
    console.error("Failed to load workspace state from storage", error);
    return { items: [] };
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WorkspaceState>(() =>
    loadWorkspaceState(),
  );

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      console.error("Failed to persist workspace state", error);
    }
  }, [state]);

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
      addItem,
      getItems,
      removeItem,
    }),
    [state, addItem, getItems, removeItem],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}
