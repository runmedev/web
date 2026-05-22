import { useEffect } from "react";
import { useCurrentDoc } from "../contexts/CurrentDocContext";
import { useNotebookContext } from "../contexts/NotebookContext";

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

export function CurrentDocInitializer() {
  const { setCurrentDoc } = useCurrentDoc();
  const { openNotebook } = useNotebookContext();

  useEffect(() => { 
    const params = new URLSearchParams(window.location.search);
    const docParam = params.get("doc");
    if (!docParam || !isNotebookDocParam(docParam)) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const result = await openNotebook(docParam);
        if (cancelled) {
          return;
        }
        setCurrentDoc(result.localUri);
      } catch (error) {
        console.error("Failed to open notebook from URL", error);
      } finally {
        if (!cancelled) {
          clearDocParam();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [openNotebook, setCurrentDoc]);

  return null;
}
