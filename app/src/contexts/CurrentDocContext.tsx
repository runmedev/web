import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { getNotebookSessionPersistence } from "../lib/notebookSessionPersistence";

interface CurrentDocContextValue {
  getCurrentDoc: () => string | null;
  setCurrentDoc: (uri: string | null) => void;
}

const CurrentDocContext = createContext<CurrentDocContextValue | undefined>(
  undefined,
);

export function useCurrentDoc() {
  const ctx = useContext(CurrentDocContext);
  if (!ctx) {
    throw new Error("useCurrentDoc must be used within a CurrentDocProvider");
  }
  return ctx;
}

export function CurrentDocProvider({ children }: { children: ReactNode }) {
  const [currentDoc, setCurrentDocState] = useState<string | null>(null);

  const loadStoredCurrentDoc = useCallback((): string | null => {
    return getNotebookSessionPersistence().loadCurrentDoc();
  }, []);

  useEffect(() => {
    setCurrentDocState(loadStoredCurrentDoc());
  }, [loadStoredCurrentDoc]);

  const getCurrentDoc = useCallback(() => {
    return currentDoc;
  }, [currentDoc]);

  const setCurrentDoc = useCallback(
    (localUri: string | null) => {
      if (currentDoc === localUri) {
        return;
      }
      // Avoid no-op updates that can trigger unnecessary renders.
      setCurrentDocState((prev) => {
        if (prev === localUri) {
          return prev;
        }
        return localUri;
      });

      getNotebookSessionPersistence().saveCurrentDoc(localUri);
    },
    [currentDoc],
  );

  const value = useMemo<CurrentDocContextValue>(
    () => ({
      getCurrentDoc,
      setCurrentDoc,
    }),
    [getCurrentDoc, setCurrentDoc],
  );

  return (
    <CurrentDocContext.Provider value={value}>
      {children}
    </CurrentDocContext.Provider>
  );
}
