import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";

import { ContentsNotebookStore } from "../storage/contents";

interface ContentsStoreContextValue {
  contentsStore: ContentsNotebookStore | null;
  setContentsStore: (store: ContentsNotebookStore | null) => void;
}

const ContentsStoreContext = createContext<
  ContentsStoreContextValue | undefined
>(undefined);

export function useContentsStore() {
  const context = useContext(ContentsStoreContext);
  if (!context) {
    throw new Error(
      "useContentsStore must be used within a ContentsStoreProvider",
    );
  }
  return context;
}

export function ContentsStoreProvider({
  children,
  initialStore = null,
}: {
  children: ReactNode;
  initialStore?: ContentsNotebookStore | null;
}) {
  const storeRef = useRef<ContentsNotebookStore | null>(initialStore);
  const [, setVersion] = useState(0);

  const setContentsStore = useCallback(
    (next: ContentsNotebookStore | null) => {
      storeRef.current = next;
      setVersion((prev) => prev + 1);
    },
    [],
  );

  return (
    <ContentsStoreContext.Provider
      value={{ contentsStore: storeRef.current, setContentsStore }}
    >
      {children}
    </ContentsStoreContext.Provider>
  );
}
