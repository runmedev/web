import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { useNotebookStore } from "./NotebookStoreContext";

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
  // Helper that reads the current doc value straight from the URL. We call this
  // exactly once on initialisation and again on popstate events so the context
  // stays aligned with browser navigation.
  const { store } = useNotebookStore();

  const [currentDoc, setCurrentDocState] = useState<string | null>(null);

  const resolveFromLocation = useCallback(async () => {
    if (!store) {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const doc = params.get("doc");

    if (!doc) {
      setCurrentDocState(null);
      return;
    }

    if (doc.startsWith("local://")) {
      setCurrentDocState(doc);
      return;
    }

    try {
      const localUri = await store.addFile(doc);
      setCurrentDocState(localUri);
    } catch (error) {
      console.error("Failed to mirror remote document", error);
      setCurrentDocState(null);
    }
  }, [store]);

  useEffect(() => {
    void resolveFromLocation();
  }, [resolveFromLocation]);

  useEffect(() => {
    const handlePopState = () => {
      void resolveFromLocation();
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [resolveFromLocation]);

  const getCurrentDoc = useCallback(() => {
    return currentDoc;
  }, [currentDoc]);

  const setCurrentDoc = useCallback(
    (localUri: string | null) => {
      if (currentDoc === localUri) {
        return;
      }
      // Avoid no-op updates that can trigger unnecessary renders/URL writes.
      setCurrentDocState((prev) => {
        if (prev === localUri) {
          return prev;
        }
        return localUri;
      });

      const updateUrl = async () => {
        const nextUrl = new URL(window.location.href);
        if (!localUri) {
          nextUrl.searchParams.delete("doc");
        } else if (store) {
          try {
            const metadata = await store.getMetadata(localUri);
            const remote = metadata?.remoteUri;
            if (remote) {
              nextUrl.searchParams.set("doc", remote);
            } else {
              nextUrl.searchParams.delete("doc");
            }
          } catch (error) {
            console.error("Failed to resolve remote URI for", localUri, error);
            nextUrl.searchParams.delete("doc");
          }
        } else {
          nextUrl.searchParams.delete("doc");
        }

        window.history.replaceState(
          null,
          "",
          `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
        );
      };

      void updateUrl();
    },
    [currentDoc, store],
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
