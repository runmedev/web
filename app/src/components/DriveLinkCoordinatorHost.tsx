import { useEffect } from "react";
import { useLocation } from "react-router-dom";

import { useGoogleAuth } from "../contexts/GoogleAuthContext";
import { useNotebookStore } from "../contexts/NotebookStoreContext";
import { useWorkspace } from "../contexts/WorkspaceContext";
import { useCurrentDoc } from "../contexts/CurrentDocContext";
import { useNotebookContext } from "../contexts/NotebookContext";
import { driveLinkCoordinator } from "../lib/driveLinkCoordinator";

export function DriveLinkCoordinatorHost() {
  const location = useLocation();
  const { ensureAccessToken } = useGoogleAuth();
  const { store } = useNotebookStore();
  const { addItem, getItems, removeItem } = useWorkspace();
  const { setCurrentDoc } = useCurrentDoc();
  const { openNotebook } = useNotebookContext();

  useEffect(() => {
    if (!store) {
      driveLinkCoordinator.configure(null);
      return;
    }

    driveLinkCoordinator.configure({
      ensureAccessToken,
      updateFolder: (remoteUri: string, name?: string) =>
        store.updateFolder(remoteUri, name),
      addFile: (remoteUri: string, name?: string) =>
        store.addFile(remoteUri, name),
      addWorkspaceItem: addItem,
      removeWorkspaceItem: removeItem,
      getWorkspaceItems: getItems,
      openNotebook: async (localUri: string) => {
        const result = await openNotebook(localUri);
        setCurrentDoc(result.localUri);
      },
    });

    const consumeUrlIntent = () => {
      if (driveLinkCoordinator.consumeUrlIntentFromLocation()) {
        void driveLinkCoordinator.processPending();
      }
    };

    consumeUrlIntent();
    void driveLinkCoordinator.processPending();
    window.addEventListener("focus", consumeUrlIntent);
    window.addEventListener("pageshow", consumeUrlIntent);
    window.addEventListener("popstate", consumeUrlIntent);

    return () => {
      window.removeEventListener("focus", consumeUrlIntent);
      window.removeEventListener("pageshow", consumeUrlIntent);
      window.removeEventListener("popstate", consumeUrlIntent);
    };
  }, [
    addItem,
    ensureAccessToken,
    getItems,
    openNotebook,
    removeItem,
    setCurrentDoc,
    store,
    location.pathname,
    location.search,
  ]);

  return null;
}

export default DriveLinkCoordinatorHost;
