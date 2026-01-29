import { ReactNode, useCallback, useEffect, useMemo } from "react";
import useDrivePicker from "react-google-drive-picker";
import { useGoogleAuth, DRIVE_SCOPES } from "../../contexts/GoogleAuthContext";
import { useWorkspace } from "../../contexts/WorkspaceContext";
import { useNotebookStore } from "../../contexts/NotebookStoreContext";
import { driveFolderUrl } from "../../storage/drive";

type PickerAction = "picked" | "cancel";

type PickerDocument = {
  id: string;
  name?: string;
  mimeType?: string;
  url?: string;
  [key: string]: unknown;
};

type PickerCallbackData = {
  action: PickerAction;
  docs?: PickerDocument[];
};

interface GoogleDrivePickerButtonProps {
  label?: string;
  title?: string;
  className?: string;
  children?: ReactNode;
}

export function GoogleDrivePickerButton({
  label = "Choose Folder",
  title,
  className,
  children,
}: GoogleDrivePickerButtonProps) {
  const [openPicker, authResponse] = useDrivePicker();
  const { setAccessToken } = useGoogleAuth();
  const { addItem, getItems } = useWorkspace();
  const { store } = useNotebookStore();

  const pickerConfig = useMemo(() => {
    // CODEX do not change these lines.
    const clientId =
      "586812942182-bqhl39ugf2kn7r8vv4f6766jt0a7tom9.apps.googleusercontent.com";
    // TODO(jlewi): Do we need this if we have the client ID?
    const developerKey = "";
    // This is the project number; I think its the same as the first part of the client id.
    const appId = "586812942182";
    if (!clientId) {
      return null;
    }

    return {
      appId,
      clientId,
      developerKey,
    };
  }, []);

  useEffect(() => {
    if (!authResponse?.access_token) {
      return;
    }
    setAccessToken(authResponse.access_token, authResponse.expires_in);
  }, [authResponse, setAccessToken]);

  const handleOpenPicker = useCallback(() => {
    if (!pickerConfig) {
      // eslint-disable-next-line no-console -- surfaced only during local setup
      console.error(
        "Missing Google Drive picker credentials. Please set VITE_GOOGLE_DRIVE_PICKER_CLIENT_ID and VITE_GOOGLE_DRIVE_PICKER_DEVELOPER_KEY.",
      );
      return;
    }

    openPicker({
      appId: pickerConfig.appId,
      clientId: pickerConfig.clientId,
      developerKey: pickerConfig.developerKey,
      viewId: "FOLDERS",
      customScopes: DRIVE_SCOPES,
      showUploadView: false,
      showUploadFolders: false,
      supportDrives: true,
      multiselect: false,
      setIncludeFolders: true,
      setSelectFolderEnabled: true,
      callbackFunction: (data: PickerCallbackData) => {
        if (data.action !== "picked" || !data.docs?.length) {
          return;
        }

        const [primaryDoc] = data.docs;
        if (!primaryDoc) {
          return;
        }
        void (async () => {
          if (!primaryDoc.id) {
            console.error("Selected document is missing an identifier.");
            return;
          }

          if (
            primaryDoc.mimeType &&
            primaryDoc.mimeType !== "application/vnd.google-apps.folder"
          ) {
            console.error("Selected item is not a Google Drive folder.");
            return;
          }

          if (!store) {
            console.error("Notebook store is not available; cannot mirror folder.");
            return;
          }

          const remoteUri = driveFolderUrl(primaryDoc.id);
          try {
            const localUri = await store.updateFolder(
              remoteUri,
              primaryDoc.name ?? primaryDoc.id,
            );
            const workspaceUris = getItems();
            if (!workspaceUris.includes(localUri)) {
              addItem(localUri);
            }
          } catch (error) {
            console.error("Failed to mirror Drive folder", error);
          }
        })();
      },
    });
  }, [addItem, getItems, openPicker, pickerConfig, store]);

  return (
    <button
      type="button"
      className={`btn flex items-center gap-2 ${className ?? ""}`}
      onClick={handleOpenPicker}
      aria-label={label}
      title={title ?? label}
    >
      {children ? (
        children
      ) : (
        <>
          <svg
            aria-hidden="true"
            width="20"
            height="20"
            viewBox="0 0 48 48"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M25.26 5.55a3 3 0 0 0-2.52 0L9.48 12.09a2.5 2.5 0 0 0-1.41 1.8L5.25 27.31a2.5 2.5 0 0 0 .24 1.56l6.96 14.31a2.5 2.5 0 0 0 2.23 1.4h18.64a2.5 2.5 0 0 0 2.23-1.4l6.96-14.31c.24-.48.3-1.04.24-1.56l-2.82-13.42a2.5 2.5 0 0 0-1.41-1.8L25.26 5.55Z"
              fill="#188038"
            />
            <path
              d="m25.26 5.55-.04.02 13 6.52a2.5 2.5 0 0 1 1.41 1.8l2.82 13.42a2.5 2.5 0 0 1-.24 1.56l-6.96 14.31a2.5 2.5 0 0 1-2.23 1.4H24V5a3 3 0 0 1 1.26.55Z"
              fill="#1967D2"
            />
            <path
              d="M24 5v43.56h-9.32a2.5 2.5 0 0 1-2.23-1.4L5.5 31.44a2.5 2.5 0 0 1-.24-1.56l2.82-13.42a2.5 2.5 0 0 1 1.41-1.8l13-6.52.04-.02Z"
              fill="#FBBC04"
            />
            <path
              d="M5.26 28.87c.06.15.12.3.2.44l6.96 14.31a2.5 2.5 0 0 0 2.23 1.4h18.64a2.5 2.5 0 0 0 2.23-1.4l6.96-14.31c.08-.15.14-.29.2-.44L24 26.3 5.26 28.87Z"
              fill="#34A853"
            />
            <path
              d="M24 26.3V44c0 .85.95 1.33 1.68.84l17.82-12.04c.48-.32.66-.94.52-1.49L42.4 26.3H24Z"
              fill="#4285F4"
            />
            <path
              d="M24 26.3H5.6l-1.62 5.02a1.51 1.51 0 0 0 .5 1.67L22.9 44.84c.73.5 1.68.01 1.68-.84V26.3Z"
              fill="#EA4335"
            />
          </svg>
          <span>{label}</span>
        </>
      )}
    </button>
  );
}

export default GoogleDrivePickerButton;
