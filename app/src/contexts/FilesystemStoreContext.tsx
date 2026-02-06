import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";

import { FilesystemNotebookStore } from "../storage/fs";

interface FilesystemStoreContextValue {
  fsStore: FilesystemNotebookStore | null;
  setFsStore: (store: FilesystemNotebookStore | null) => void;
}

const FilesystemStoreContext = createContext<
  FilesystemStoreContextValue | undefined
>(undefined);

export function useFilesystemStore() {
  const context = useContext(FilesystemStoreContext);
  if (!context) {
    throw new Error(
      "useFilesystemStore must be used within a FilesystemStoreProvider",
    );
  }
  return context;
}

export function FilesystemStoreProvider({
  children,
  initialStore = null,
}: {
  children: ReactNode;
  initialStore?: FilesystemNotebookStore | null;
}) {
  const storeRef = useRef<FilesystemNotebookStore | null>(initialStore);
  const [, setVersion] = useState(0);

  const setFsStore = useCallback((next: FilesystemNotebookStore | null) => {
    storeRef.current = next;
    setVersion((prev) => prev + 1);
  }, []);

  return (
    <FilesystemStoreContext.Provider
      value={{ fsStore: storeRef.current, setFsStore }}
    >
      {children}
    </FilesystemStoreContext.Provider>
  );
}
