import {
  FolderIcon,
  ChatBubbleLeftRightIcon,
  UserCircleIcon,
} from "@heroicons/react/24/outline";
import { CloudIcon as CloudSolidIcon } from "@heroicons/react/24/solid";
import { useCallback, useState } from "react";

import ChatKitPanel from "../ChatKit/ChatKitPanel";
import WorkspaceExplorer from "../Workspace/WorkspaceExplorer";
import { getBrowserAdapter, useBrowserAuthData } from "../../browserAdapter.client";
import { useGoogleAuth } from "../../contexts/GoogleAuthContext";
import { useSidePanel } from "../../contexts/SidePanelContext";

const sideButtonBase = "group side-btn";

const sideButtonInactive = "side-btn-inactive";

const sideButtonActive = "side-btn-active";

const tooltipBase = "side-tooltip";

export function SidePanelToolbar() {
  const { activePanel, togglePanel } = useSidePanel();
  const authData = useBrowserAuthData();
  const browserAdapter = getBrowserAdapter();
  const { ensureAccessToken, isDriveSyncing } = useGoogleAuth();
  const [isDriveAuthPending, setIsDriveAuthPending] = useState(false);

  const driveStatus = isDriveSyncing ? "Syncing" : "Not syncing";
  const handleDriveStatusClick = useCallback(async () => {
    if (isDriveSyncing || isDriveAuthPending) {
      return;
    }
    setIsDriveAuthPending(true);
    try {
      await ensureAccessToken({ interactive: true });
    } catch (error) {
      if (!String(error).includes("Redirecting to Google OAuth")) {
        console.error("Failed to start Google Drive auth flow", error);
      }
    } finally {
      setIsDriveAuthPending(false);
    }
  }, [ensureAccessToken, isDriveAuthPending, isDriveSyncing]);

  return (
    <div className="flex h-full w-12 flex-col items-center justify-between">
      <div className="flex flex-col items-center gap-2 pt-2">
        <button
          type="button"
          className={`${sideButtonBase} ${
            activePanel === "explorer" ? sideButtonActive : sideButtonInactive
          }`}
          aria-pressed={activePanel === "explorer"}
          aria-label="Toggle Explorer panel"
          onClick={() => togglePanel("explorer")}
        >
          <FolderIcon className="h-5 w-5" />
          <span className={tooltipBase}>File Explorer</span>
        </button>
        <button
          type="button"
          className={`${sideButtonBase} ${
            activePanel === "chatkit" ? sideButtonActive : sideButtonInactive
          }`}
          aria-pressed={activePanel === "chatkit"}
          aria-label="Toggle ChatKit panel"
          onClick={() => togglePanel("chatkit")}
        >
          <ChatBubbleLeftRightIcon className="h-5 w-5" />
          <span className={tooltipBase}>AI Chat</span>
        </button>
      </div>
      <div className="flex flex-col items-center gap-2 pb-2">
        <button
          type="button"
          className={`${sideButtonBase} ${
            isDriveSyncing || isDriveAuthPending
              ? sideButtonActive
              : sideButtonInactive
          }`}
          aria-label={`Google Drive status: ${driveStatus}`}
          onClick={() => {
            void handleDriveStatusClick();
          }}
        >
          <span className="relative inline-flex h-5 w-5 items-center justify-center">
            <CloudSolidIcon
              className={`h-5 w-5 ${
                isDriveSyncing ? "text-emerald-500" : "text-red-500"
              }`}
            />
            {!isDriveSyncing && (
              <span className="pointer-events-none absolute h-0.5 w-6 -rotate-45 rounded bg-red-600" />
            )}
          </span>
          <span className={tooltipBase}>{`Google Drive: ${driveStatus}`}</span>
        </button>
        <button
          type="button"
          className={`${sideButtonBase} ${sideButtonInactive}`}
          aria-label={authData ? "Logout" : "Login"}
          onClick={() =>
            authData
              ? browserAdapter.logout()
              : browserAdapter.loginWithRedirect()
          }
        >
          <UserCircleIcon className="h-5 w-5" />
          <span className={tooltipBase}>{authData ? "Logout" : "Login"}</span>
        </button>
      </div>
    </div>
  );
}

export function SidePanelContent() {
  const { activePanel } = useSidePanel();

  if (!activePanel) {
    return null;
  }

  if (activePanel === "explorer") {
    return (
      <div className="flex h-full min-h-0 w-full">
        <WorkspaceExplorer />
      </div>
    );
  }
  if (activePanel === "chatkit") {
    return (
      <div className="flex h-full min-h-0 w-full overflow-hidden">
        <ChatKitPanel />
      </div>
    );
  }
  return null;
}
