import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";

import LocalNotebooks from "../storage/local";

interface NotebookStoreContextValue {
  store: LocalNotebooks | null;
  setStore: (store: LocalNotebooks | null) => void;
}

const NotebookStoreContext = createContext<
  NotebookStoreContextValue | undefined
>(undefined);

export function useNotebookStore() {
  const context = useContext(NotebookStoreContext);
  if (!context) {
    throw new Error(
      "useNotebookStore must be used within a NotebookStoreProvider",
    );
  }
  return context;
}

export function NotebookStoreProvider({
  children,
  initialStore = null,
}: {
  children: ReactNode;
  initialStore?: LocalNotebooks | null;
}) {
  const storeRef = useRef<LocalNotebooks | null>(initialStore);
  const [, setVersion] = useState(0);

  const setStore = useCallback((next: LocalNotebooks | null) => {
    storeRef.current = next;
    setVersion((prev) => prev + 1);
  }, []);

  return (
    <NotebookStoreContext.Provider
      value={{ store: storeRef.current, setStore }}
    >
      {children}
    </NotebookStoreContext.Provider>
  );
}
