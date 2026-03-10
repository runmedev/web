import { useEffect } from "react";

import { useGoogleAuth } from "../contexts/GoogleAuthContext";
import { useNotebookStore } from "../contexts/NotebookStoreContext";
import { useWorkspace } from "../contexts/WorkspaceContext";
import { useCurrentDoc } from "../contexts/CurrentDocContext";
import { driveLinkCoordinator } from "../lib/driveLinkCoordinator";

export function DriveLinkCoordinatorHost() {
  const { ensureAccessToken } = useGoogleAuth();
  const { store } = useNotebookStore();
  const { addItem, getItems, removeItem } = useWorkspace();
  const { setCurrentDoc } = useCurrentDoc();

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
      openNotebook: (localUri: string) => {
        setCurrentDoc(localUri);
      },
    });

    driveLinkCoordinator.consumeUrlIntentFromLocation();
    void driveLinkCoordinator.processPending();
  }, [addItem, ensureAccessToken, getItems, removeItem, setCurrentDoc, store]);

  return null;
}

export default DriveLinkCoordinatorHost;
