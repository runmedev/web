import { useEffect } from "react";

import { useGoogleAuth } from "../contexts/GoogleAuthContext";
import { useNotebookStore } from "../contexts/NotebookStoreContext";
import { useWorkspace } from "../contexts/WorkspaceContext";
import { useCurrentDoc } from "../contexts/CurrentDocContext";
import { useNotebookContext } from "../contexts/NotebookContext";
import { driveLinkCoordinator } from "../lib/driveLinkCoordinator";

export function DriveLinkCoordinatorHost() {
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

    driveLinkCoordinator.consumeUrlIntentFromLocation();
    void driveLinkCoordinator.processPending();
  }, [
    addItem,
    ensureAccessToken,
    getItems,
    openNotebook,
    removeItem,
    setCurrentDoc,
    store,
  ]);

  return null;
}

export default DriveLinkCoordinatorHost;
