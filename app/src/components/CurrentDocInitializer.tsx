import { useEffect } from "react";
import { useCurrentDoc } from "../contexts/CurrentDocContext";
import { useNotebookContext } from "../contexts/NotebookContext";
import { useNotebookStore } from "../contexts/NotebookStoreContext";

function isNotebookDocParam(uri: string): boolean {
  return uri.startsWith("local://file/") || uri.startsWith("fs://");
}

function clearDocParam(): void {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.delete("doc");
  window.history.replaceState(
    null,
    "",
    `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
  );
}

function requiresNotebookStore(uri: string): boolean {
  return !uri.startsWith("local://file/");
}

export function CurrentDocInitializer() {
  const { setCurrentDoc } = useCurrentDoc();
  const { openNotebook } = useNotebookContext();
  const { store } = useNotebookStore();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const docParam = params.get("doc");
    if (!docParam || !isNotebookDocParam(docParam)) {
      return;
    }
    if (requiresNotebookStore(docParam) && !store) {
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) {
        return;
      }
      void (async () => {
        try {
          const result = await openNotebook(docParam);
          if (cancelled) {
            return;
          }
          setCurrentDoc(result.localUri);
          clearDocParam();
        } catch (error) {
          console.error("Failed to open notebook from URL", error);
        }
      })();
    });

    return () => {
      cancelled = true;
    };
  }, [openNotebook, setCurrentDoc, store]);

  return null;
}
