import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

import { type NotebookData, type NotebookSnapshot } from "../lib/notebookData";
import {
  getNotebookDataController,
  type OpenNotebookEntry,
  type OpenNotebookResult,
} from "../lib/notebookDataController";
import { appLogger } from "../lib/logging/runtime";
import { appState } from "../lib/runtime/AppState";
import { isNotebookDocumentUri } from "../lib/workspaceDocuments/workspaceDocumentTypes";
import { useCurrentDoc } from "./CurrentDocContext";
import { useNotebookStore } from "./NotebookStoreContext";

type NotebookContextValue = {
  getNotebookData: (uri: string) => NotebookData | undefined;
  openNotebook: (
    uri: string,
    options?: { name?: string },
  ) => Promise<OpenNotebookResult>;
  useNotebookSnapshot: (uri: string) => NotebookSnapshot | null;
  useNotebookList: () => OpenNotebookEntry[];
  removeNotebook: (uri: string) => string | null;
};

const NotebookContext = createContext<NotebookContextValue | undefined>(undefined);

export function useNotebookContext() {
  const ctx = useContext(NotebookContext);
  if (!ctx) {
    throw new Error("useNotebookContext must be used within a NotebookProvider");
  }
  return ctx;
}

export function NotebookProvider({ children }: { children: ReactNode }) {
  const { store } = useNotebookStore();
  const { getCurrentDoc, setCurrentDoc } = useCurrentDoc();
  const controller = getNotebookDataController();
  const restoredCurrentDocRef = useRef(false);

  useEffect(() => {
    controller.configureStores({ localNotebooks: store });
  }, [controller, store]);

  const getNotebookData = useCallback(
    (uri: string) => controller.getNotebookData(uri),
    [controller],
  );

  const openNotebook = useCallback(
    (uri: string, options?: { name?: string }) =>
      controller.openNotebook(uri, options),
    [controller],
  );

  const removeNotebook = useCallback(
    (uri: string) => controller.closeNotebook(uri),
    [controller],
  );

  const useNotebookSnapshot = useCallback(
    (uri: string) => {
      const subscribe = useCallback(
        (listener: () => void) => controller.subscribe(listener),
        [controller],
      );
      const getSnapshot = useCallback(
        () => (uri ? controller.getNotebookSnapshot(uri) : null),
        [controller, uri],
      );
      return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    },
    [controller],
  );

  const useNotebookList = useCallback(() => {
    const subscribe = useCallback(
      (listener: () => void) => controller.subscribe(listener),
      [controller],
    );
    const getSnapshot = useCallback(
      () => controller.getSnapshot().openNotebooks,
      [controller],
    );
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }, [controller]);

  const openAndSelectNotebook = useCallback(
    async (uri: string, options?: { name?: string }) => {
      const result = await controller.openNotebook(uri, options);
      setCurrentDoc(result.localUri);
      return result;
    },
    [controller, setCurrentDoc],
  );

  useEffect(() => {
    appState.setOpenNotebookHandler(async (uri: string) => {
      await openAndSelectNotebook(uri);
    });
    return () => {
      appState.setOpenNotebookHandler(null);
    };
  }, [openAndSelectNotebook]);

  useEffect(() => {
    const openNotebooks = controller.getOpenNotebooks();
    const currentDoc = getCurrentDoc();
    if (!currentDoc && openNotebooks.length > 0) {
      setCurrentDoc(openNotebooks[0]?.uri ?? null);
      return;
    }
    if (
      currentDoc &&
      isNotebookDocumentUri(currentDoc) &&
      !restoredCurrentDocRef.current &&
      openNotebooks.length === 0
    ) {
      restoredCurrentDocRef.current = true;
      void controller.openNotebook(currentDoc).catch((error) => {
        appLogger.error("Failed to restore selected notebook", {
          attrs: { scope: "notebook-session", error },
        });
      });
    }
  }, [controller, getCurrentDoc, setCurrentDoc, store]);

  const value = useMemo<NotebookContextValue>(
    () => ({
      getNotebookData,
      openNotebook,
      useNotebookSnapshot,
      useNotebookList,
      removeNotebook,
    }),
    [
      getNotebookData,
      openNotebook,
      removeNotebook,
      useNotebookList,
      useNotebookSnapshot,
    ],
  );

  return <NotebookContext.Provider value={value}>{children}</NotebookContext.Provider>;
}
