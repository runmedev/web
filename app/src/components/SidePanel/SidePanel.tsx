import {
  FolderIcon,
  ChatBubbleLeftRightIcon,
  UserCircleIcon,
  Cog6ToothIcon,
} from "@heroicons/react/24/outline";

import ChatKitPanel from "../ChatKit/ChatKitPanel";
import WorkspaceExplorer from "../Workspace/WorkspaceExplorer";
import { getBrowserAdapter, useBrowserAuthData } from "../../browserAdapter.client";
import { useSidePanel } from "../../contexts/SidePanelContext";
import Settings from "../Settings/Settings";

const sideButtonBase = "group side-btn";

const sideButtonInactive = "side-btn-inactive";

const sideButtonActive = "side-btn-active";

const tooltipBase = "side-tooltip";

export function SidePanelToolbar() {
  const { activePanel, togglePanel } = useSidePanel();
  const authData = useBrowserAuthData();
  const browserAdapter = getBrowserAdapter();

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
        <button
          type="button"
          className={`${sideButtonBase} ${
            activePanel === "settings" ? sideButtonActive : sideButtonInactive
          }`}
          aria-pressed={activePanel === "settings"}
          aria-label="Toggle settings panel"
          onClick={() => togglePanel("settings")}
        >
          <Cog6ToothIcon className="h-5 w-5" />
          <span className={tooltipBase}>Settings</span>
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
  if (activePanel === "settings") {
    return (
      <div className="flex h-full min-h-0 w-full">
        <Settings />
      </div>
    );
  }
  return null;
}
