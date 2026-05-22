import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

const CURRENT_DOC_STORAGE_KEY = "runme/currentDoc";

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

  return (
    <CurrentDocContext.Provider value={value}>
      {children}
    </CurrentDocContext.Provider>
  );
}
