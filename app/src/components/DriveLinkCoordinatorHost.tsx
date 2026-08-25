import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

import { useGoogleAuth } from "../contexts/GoogleAuthContext";
import { useNotebookStore } from "../contexts/NotebookStoreContext";
import { useWorkspace } from "../contexts/WorkspaceContext";
import { useCurrentDoc } from "../contexts/CurrentDocContext";
import { useNotebookContext } from "../contexts/NotebookContext";
import { useWorkspaceDocumentContext } from "../contexts/WorkspaceDocumentContext";
import { driveLinkCoordinator } from "../lib/driveLinkCoordinator";
import { fetchSharedNotebookPreflight } from "../storage/drive";

export function DriveLinkCoordinatorHost() {
  const location = useLocation();
  const { driveAccount, driveCredentialStatus, ensureAccessToken } =
    useGoogleAuth();
  const drivePrincipalRef = useRef<string | null>(
    driveCredentialStatus.effectivePrincipal ?? driveAccount,
  );
  drivePrincipalRef.current =
    driveCredentialStatus.effectivePrincipal ?? driveAccount;
  const { store } = useNotebookStore();
  const { addItem, getItems, removeItem } = useWorkspace();
  const { setCurrentDoc } = useCurrentDoc();
  const { openNotebook } = useNotebookContext();
  const { showDocument } = useWorkspaceDocumentContext();

  useEffect(() => {
    if (!store) {
      driveLinkCoordinator.configure(null);
      return;
    }

    driveLinkCoordinator.configure({
      ensureAccessToken,
      getEffectivePrincipal: () => drivePrincipalRef.current,
      fetchPreflight: (remoteUri: string) =>
        fetchSharedNotebookPreflight(remoteUri, () =>
          ensureAccessToken({ interactive: false }),
        ),
      updateFolder: (remoteUri: string, name?: string) =>
        store.updateFolder(remoteUri, name),
      importFile: (remoteUri, name, options) =>
        store.importTrustedDriveSnapshot(remoteUri, name, options),
      addWorkspaceItem: addItem,
      removeWorkspaceItem: removeItem,
      getWorkspaceItems: getItems,
      openNotebook: async (localUri: string, options?: { focus?: boolean }) => {
        const result = await openNotebook(localUri);
        if (options?.focus !== false) {
          showDocument(result.localUri, {
            title: result.entry.name,
          });
          setCurrentDoc(result.localUri);
        }
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
    driveAccount,
    driveCredentialStatus.effectivePrincipal,
    ensureAccessToken,
    getItems,
    openNotebook,
    removeItem,
    setCurrentDoc,
    showDocument,
    store,
    location.pathname,
    location.search,
  ]);

  return null;
}

export default DriveLinkCoordinatorHost;
