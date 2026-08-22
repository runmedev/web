import { ReactNode, useCallback, useState } from "react";
import { useGoogleAuth } from "../../contexts/GoogleAuthContext";
import { useWorkspace } from "../../contexts/WorkspaceContext";
import { useNotebookStore } from "../../contexts/NotebookStoreContext";
import { driveFolderUrl } from "../../storage/drive";
import { googleClientManager } from "../../lib/googleClientManager";
import { markOnboardingTaskComplete } from "../../lib/onboarding";
import { tourUiController } from "../../lib/tourUiController";
import { appLogger } from "../../lib/logging/runtime";
import { GoogleDriveFolderChooserDialog } from "./GoogleDriveFolderChooserDialog";
import { openGoogleDrivePicker } from "./googleDrivePickerViews";
import { listGoogleSharedDrives } from "./googleSharedDrives";
import type { GoogleSharedDrive } from "./googleSharedDrives";

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
  const { ensureAccessToken } = useGoogleAuth();
  const { addItem, getItems } = useWorkspace();
  const { store } = useNotebookStore();
  const [sharedDrives, setSharedDrives] = useState<GoogleSharedDrive[] | null>(
    null,
  );
  const [pickerAccessToken, setPickerAccessToken] = useState("");
  const [sharedDriveListError, setSharedDriveListError] = useState("");

  const getPickerConfig = useCallback(() => {
    const { clientId, developerKey, appId } =
      googleClientManager.getDrivePickerConfig();
    if (!clientId) {
      return null;
    }
    return {
      appId,
      clientId,
      developerKey,
    };
  }, []);

  const mountFolder = useCallback(
    async (folderId: string, folderName: string) => {
      if (!store) {
        appLogger.error("Notebook store is unavailable for a Drive folder", {
          attrs: {
            scope: "storage.drive.picker",
            code: "DRIVE_FOLDER_STORE_UNAVAILABLE",
          },
        });
        return;
      }

      try {
        const localUri = await store.updateFolder(
          driveFolderUrl(folderId),
          folderName,
        );
        if (!getItems().includes(localUri)) {
          addItem(localUri);
        }
        markOnboardingTaskComplete("add-drive-folder");
        tourUiController.recordGoogleDriveFolderAdded();
      } catch (error) {
        appLogger.error("Failed to mirror Drive folder", {
          attrs: {
            scope: "storage.drive.picker",
            code: "DRIVE_FOLDER_MIRROR_FAILED",
            error: String(error),
          },
        });
        setPickerAccessToken(accessToken);
        setSharedDriveListError(
          "Runme could not list Shared Drives. Verify that the Google Drive API is enabled for this credential's project and that it can list the Shared Drive. You can still browse My Drive or nested folders.",
        );
        setSharedDrives([]);
        return;
      }
    },
    [addItem, getItems, store],
  );

  const openFolderPicker = useCallback(
    async (
      accessToken: string,
      pickerConfig: NonNullable<ReturnType<typeof getPickerConfig>>,
    ) => {
      try {
        await openGoogleDrivePicker({
          token: accessToken,
          appId: pickerConfig.appId,
          developerKey: pickerConfig.developerKey,
          kind: "folder",
          callback: (data) => {
            const primaryDoc =
              data.action === "picked" ? data.docs?.[0] : undefined;
            if (!primaryDoc?.id) {
              return;
            }
            if (
              primaryDoc.mimeType &&
              primaryDoc.mimeType !== "application/vnd.google-apps.folder"
            ) {
              appLogger.error("Selected Drive item is not a folder", {
                attrs: {
                  scope: "storage.drive.picker",
                  code: "DRIVE_PICKER_DOCUMENT_NOT_FOLDER",
                },
              });
              return;
            }
            void mountFolder(
              primaryDoc.id,
              primaryDoc.name ?? primaryDoc.id,
            );
          },
        });
      } catch (error) {
        appLogger.error("Failed to open Google Drive picker", {
          attrs: {
            scope: "storage.drive.picker",
            code: "DRIVE_PICKER_OPEN_FAILED",
            error: String(error),
          },
        });
      }
    },
    [mountFolder],
  );

  const handleOpenPicker = useCallback(() => {
    const pickerConfig = getPickerConfig();
    if (!pickerConfig) {
      appLogger.error("Google Drive picker is not configured", {
        attrs: {
          scope: "storage.drive.picker",
          code: "DRIVE_PICKER_CLIENT_ID_MISSING",
        },
      });
      return;
    }

    void (async () => {
      let accessToken = "";
      try {
        accessToken = await ensureAccessToken({ interactive: true });
      } catch (error) {
        appLogger.error("Failed to authorize Google Drive picker", {
          attrs: {
            scope: "storage.drive.picker",
            code: "DRIVE_PICKER_AUTH_FAILED",
            error: String(error),
          },
        });
        return;
      }
      if (!accessToken) {
        return;
      }

      try {
        const drives = await listGoogleSharedDrives(accessToken);
        if (drives.length > 0) {
          setPickerAccessToken(accessToken);
          setSharedDrives(drives);
          return;
        }
      } catch (error) {
        appLogger.warn("Failed to list Shared Drives before opening Picker", {
          attrs: {
            scope: "storage.drive.picker",
            code: "SHARED_DRIVE_LIST_FAILED",
            error: String(error),
          },
        });
        setPickerAccessToken(accessToken);
        setSharedDriveListError(
          "Runme could not list Shared Drives. Verify that the Google Drive API is enabled for this credential's project and that it can list the Shared Drive. You can still browse My Drive or nested folders.",
        );
        setSharedDrives([]);
        return;
      }

      await openFolderPicker(accessToken, pickerConfig);
    })();
  }, [ensureAccessToken, getPickerConfig, openFolderPicker]);

  const closeSharedDriveChooser = useCallback(() => {
    setSharedDrives(null);
    setPickerAccessToken("");
    setSharedDriveListError("");
  }, []);

  const handleBrowseFolders = useCallback(() => {
    const pickerConfig = getPickerConfig();
    const accessToken = pickerAccessToken;
    closeSharedDriveChooser();
    if (!pickerConfig || !accessToken) {
      return;
    }
    void openFolderPicker(accessToken, pickerConfig);
  }, [
    closeSharedDriveChooser,
    getPickerConfig,
    openFolderPicker,
    pickerAccessToken,
  ]);

  const handleSelectSharedDrive = useCallback(
    (drive: GoogleSharedDrive) => {
      closeSharedDriveChooser();
      void mountFolder(drive.id, drive.name);
    },
    [closeSharedDriveChooser, mountFolder],
  );

  return (
    <>
      <button
        type="button"
        data-tour-id="explorer.add-google-drive-folder"
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
      {sharedDrives ? (
        <GoogleDriveFolderChooserDialog
          drives={sharedDrives}
          errorMessage={sharedDriveListError || undefined}
          onBrowseFolders={handleBrowseFolders}
          onCancel={closeSharedDriveChooser}
          onSelectSharedDrive={handleSelectSharedDrive}
        />
      ) : null}
    </>
  );
}

export default GoogleDrivePickerButton;
