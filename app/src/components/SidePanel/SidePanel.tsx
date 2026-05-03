import {
  FolderIcon,
  ChatBubbleLeftRightIcon,
  QueueListIcon,
  UserCircleIcon,
} from "@heroicons/react/24/outline";
import { XMarkIcon } from "@heroicons/react/20/solid";
import { CloudIcon as CloudSolidIcon } from "@heroicons/react/24/solid";
import { useCallback, useEffect, useState } from "react";

import ChatKitPanel from "../ChatKit/ChatKitPanel";
import WorkspaceExplorer from "../Workspace/WorkspaceExplorer";
import { getBrowserAdapter, useBrowserAuthData } from "../../browserAdapter.client";
import { useGoogleAuth } from "../../contexts/GoogleAuthContext";
import { useCurrentDoc } from "../../contexts/CurrentDocContext";
import { useNotebookContext } from "../../contexts/NotebookContext";
import { useSidePanel } from "../../contexts/SidePanelContext";

const sideButtonBase = "group side-btn";

const sideButtonInactive = "side-btn-inactive";

const sideButtonActive = "side-btn-active";

const tooltipBase = "side-tooltip";

function getNotebookDisplayName(uri: string, name?: string): string {
  return name || uri.split("/").filter(Boolean).pop() || uri;
}

/**
 * OpenNotebooksPanel renders a lightweight "open editors" style list driven by
 * NotebookContext. It shares the same open-notebook state as the tab strip so
 * the sidebar remains a secondary view over the exact same source of truth.
 */
function OpenNotebooksPanel() {
  const { useNotebookList, removeNotebook } = useNotebookContext();
  const { getCurrentDoc, setCurrentDoc } = useCurrentDoc();
  const openNotebooks = useNotebookList();
  const currentDocUri = getCurrentDoc();

  const handleCloseNotebook = useCallback(
    (uri: string) => {
      const next = removeNotebook(uri);
      if (uri === currentDocUri) {
        setCurrentDoc(next ?? null);
      }
    },
    [currentDocUri, removeNotebook, setCurrentDoc],
  );

  return (
    <div
      id="open-notebooks-panel"
      className="flex h-full min-h-0 w-full flex-col bg-nb-surface"
    >
      <div
        id="open-notebooks-panel-header"
        className="border-b border-nb-border px-4 py-3"
      >
        <p className="text-xs font-semibold tracking-[0.18em] text-nb-text-faint uppercase">
          Open Notebooks
        </p>
        <p className="mt-1 text-sm text-nb-text-muted">
          {openNotebooks.length} {openNotebooks.length === 1 ? "notebook" : "notebooks"}
        </p>
      </div>
      <div
        id="open-notebooks-panel-list"
        className="flex-1 min-h-0 overflow-y-auto px-2 py-2"
      >
        {openNotebooks.length === 0 ? (
          <div
            id="open-notebooks-panel-empty"
            className="rounded-nb-sm border border-dashed border-nb-border bg-white/60 px-3 py-4 text-sm text-nb-text-muted"
          >
            No open notebooks yet.
          </div>
        ) : (
          <ul id="open-notebooks-list" className="space-y-1">
            {openNotebooks.map((doc) => {
              const displayName = getNotebookDisplayName(doc.uri, doc.name);
              const isActive = doc.uri === currentDocUri;
              return (
                <li key={doc.uri}>
                  <div
                    id={`open-notebook-row-${encodeURIComponent(doc.uri)}`}
                    className={`group flex items-center gap-2 rounded-nb-sm border px-2 py-2 transition-colors ${
                      isActive
                        ? "border-nb-accent bg-nb-accent-soft text-nb-text"
                        : "border-transparent bg-transparent text-nb-text-muted hover:border-nb-border hover:bg-white/80 hover:text-nb-text"
                    }`}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => setCurrentDoc(doc.uri)}
                    >
                      <div className="truncate text-sm font-medium">
                        {displayName}
                      </div>
                      <div className="truncate text-xs text-nb-text-faint">
                        {doc.uri}
                      </div>
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-nb-xs text-nb-text-faint transition-colors hover:bg-black/5 hover:text-nb-text"
                      aria-label={`Close ${displayName}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleCloseNotebook(doc.uri);
                      }}
                      onMouseDown={(event) => event.stopPropagation()}
                    >
                      <XMarkIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

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
            activePanel === "open-notebooks" ? sideButtonActive : sideButtonInactive
          }`}
          aria-pressed={activePanel === "open-notebooks"}
          aria-label="Toggle Open Notebooks panel"
          onClick={() => togglePanel("open-notebooks")}
        >
          <QueueListIcon className="h-5 w-5" />
          <span className={tooltipBase}>Open Notebooks</span>
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
  const [hasActivatedChatKit, setHasActivatedChatKit] = useState(
    activePanel === "chatkit",
  );
  const shouldRenderChatKit = hasActivatedChatKit || activePanel === "chatkit";

  useEffect(() => {
    if (activePanel === "chatkit") {
      setHasActivatedChatKit(true);
    }
  }, [activePanel]);

  if (!activePanel) {
    return null;
  }

  return (
    <div className="relative h-full min-h-0 w-full">
      <div
        className={`h-full min-h-0 w-full ${activePanel === "explorer" ? "flex" : "hidden"}`}
        aria-hidden={activePanel !== "explorer"}
      >
        <WorkspaceExplorer />
      </div>
      <div
        className={`h-full min-h-0 w-full ${activePanel === "open-notebooks" ? "flex" : "hidden"}`}
        aria-hidden={activePanel !== "open-notebooks"}
      >
        <OpenNotebooksPanel />
      </div>
      {shouldRenderChatKit ? (
        <div
          className={`h-full min-h-0 w-full overflow-hidden ${activePanel === "chatkit" ? "flex" : "hidden"}`}
          aria-hidden={activePanel !== "chatkit"}
        >
          <ChatKitPanel />
        </div>
      ) : null}
    </div>
  );
}
