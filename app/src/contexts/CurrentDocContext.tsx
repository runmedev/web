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

const CURRENT_DOC_STORAGE_KEY = "runme/currentDoc";

function isFsUri(uri: string): boolean {
  return uri.startsWith("fs://");
}

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
  const [currentDoc, setCurrentDocState] = useState<string | null>(null);

  const loadStoredCurrentDoc = useCallback((): string | null => {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
    try {
      const stored = window.localStorage.getItem(CURRENT_DOC_STORAGE_KEY);
      return stored?.trim() ? stored : null;
    } catch {
      return null;
    }
  }, []);

  const resolveFromLocation = useCallback(async () => {
    const params = new URLSearchParams(window.location.search);
    const doc = params.get("doc");

    if (!doc) {
      setCurrentDocState(loadStoredCurrentDoc());
      return;
    }

    if (doc.startsWith("local://")) {
      setCurrentDocState(doc);
      return;
    }

    if (isFsUri(doc)) {
      setCurrentDocState(doc);
      return;
    }

    // Shared Drive links are consumed by the Drive link coordinator. They are
    // not treated as steady-state current-doc values.
    setCurrentDocState(null);
  }, [loadStoredCurrentDoc]);

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
        nextUrl.searchParams.delete("doc");
        try {
          if (!localUri) {
            window.localStorage.removeItem(CURRENT_DOC_STORAGE_KEY);
          } else {
            window.localStorage.setItem(CURRENT_DOC_STORAGE_KEY, localUri);
          }
        } catch {
          // Ignore persistence failures for current-doc restore state.
        }

        window.history.replaceState(
          null,
          "",
          `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
        );
      };

      void updateUrl();
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

  useEffect(() => {
    appState.setOpenNotebookHandler((uri: string) => {
      setCurrentDoc(uri);
    });
    return () => {
      appState.setOpenNotebookHandler(null);
    };
  }, [setCurrentDoc]);

  return (
    <CurrentDocContext.Provider value={value}>
      {children}
    </CurrentDocContext.Provider>
  );
}
