import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import { getNotebookSessionPersistence } from "../lib/notebookSessionPersistence";
import { isRestorableWorkspaceDocument } from "../lib/workspaceDocuments/workspaceDocumentTypes";

interface CurrentDocContextValue {
  getCurrentDoc: () => string | null;
  setCurrentDoc: (uri: string | null) => void;
}

const CurrentDocContext = createContext<CurrentDocContextValue | undefined>(
  undefined,
);

function loadRestorableStoredCurrentDoc(): string | null {
  const uri = getNotebookSessionPersistence().loadCurrentDoc();
  return uri && isRestorableWorkspaceDocument(uri) ? uri : null;
}

export function useCurrentDoc() {
  const ctx = useContext(CurrentDocContext);
  if (!ctx) {
    throw new Error("useCurrentDoc must be used within a CurrentDocProvider");
  }
  return ctx;
}

export function CurrentDocProvider({ children }: { children: ReactNode }) {
  const [currentDoc, setCurrentDocState] = useState<string | null>(
    loadRestorableStoredCurrentDoc,
  );

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

      getNotebookSessionPersistence().saveCurrentDoc(
        localUri && isRestorableWorkspaceDocument(localUri) ? localUri : null,
      );
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
