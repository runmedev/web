import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ClientMessages } from "@runmedev/renderers";
import type { RendererContext } from "vscode-notebook-renderer";

import { JSKernel } from "../../lib/runtime/jsKernel";
import { useRunners } from "../../contexts/RunnersContext";
import { useWorkspace } from "../../contexts/WorkspaceContext";
import { useFilesystemStore } from "../../contexts/FilesystemStoreContext";
import { appState } from "../../lib/runtime/AppState";
import {
  FilesystemNotebookStore,
  isFileSystemAccessSupported,
} from "../../storage/fs";
import { Runner } from "../../lib/runner";
import { getRunnersManager } from "../../lib/runtime/runnersManager";
import { googleClientManager } from "../../lib/googleClientManager";
import { oidcConfigManager } from "../../auth/oidcConfig";
import type { OidcConfig } from "../../auth/oidcConfig";
import { getAuthData } from "../../token";
import { jwtDecode } from "jwt-decode";

const PROMPT = "> ";
const ERASE_TO_END = "\u001b[K";
const MOVE_CURSOR_COL = (col: number) => `\u001b[${col}G`;
const STORAGE_KEY = "aisre.appConsoleCollapsed";
const MAX_CONSOLE_OUTPUT = 8000;

/**
 * AppConsole wired to JSKernel. Input entered in console-view is executed
 * via JSKernel and stdout/stderr are written back to the terminal.
 */
export default function AppConsole() {
  const elemRef = useRef<any>(null);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return false;
    }
    try {
      return localStorage.getItem(STORAGE_KEY) === "true";
    } catch (error) {
      console.error("Failed to read console collapse state", error);
      return false;
    }
  });
  // Track recent console output so automated tests can assert command results
  // without scraping the xterm canvas.
  const [consoleOutput, setConsoleOutput] = useState("");

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? "true" : "false");
    } catch (error) {
      console.error("Failed to persist console collapse state", error);
    }
  }, [collapsed]);

  const consoleId = useMemo(
    () => `console-${Math.random().toString(36).substring(2, 9)}`,
    [],
  );
  const { listRunners, updateRunner, deleteRunner, defaultRunnerName } =
    useRunners();
  // WorkspaceContext provides the persisted list of workspace URIs so we can
  // mount/unmount folders from the App Console without drilling props.
  const { getItems, addItem, removeItem } = useWorkspace();
  // FilesystemStoreContext owns the File System Access API store instance that
  // actually opens folders and produces fs:// workspace URIs.
  const { fsStore, setFsStore } = useFilesystemStore();

  // Message pump to deliver stdout/stderr back into console-view.
  const messageListenerRef = useRef<((message: unknown) => void) | undefined>(
    undefined,
  );
  const sendStdout = useCallback((data: string) => {
    setConsoleOutput((prev) => {
      const next = prev + data;
      return next.length > MAX_CONSOLE_OUTPUT
        ? next.slice(-MAX_CONSOLE_OUTPUT)
        : next;
    });
    messageListenerRef.current?.({
      type: ClientMessages.terminalStdout,
      output: {
        "runme.dev/id": consoleId,
        data,
      },
    } as any);
  }, [consoleId]);

  // Lazily create the FilesystemNotebookStore if the provider has not
  // initialized it yet. This keeps the App Console usable even if a user
  // runs commands before the App initializer finishes.
  const ensureFilesystemStore = useCallback(() => {
    if (fsStore) {
      return fsStore;
    }
    if (!isFileSystemAccessSupported()) {
      return null;
    }
    const store = new FilesystemNotebookStore();
    appState.setFilesystemStore(store);
    setFsStore(store);
    return store;
  }, [fsStore, setFsStore]);

  // Open the native directory picker via File System Access API and mount the
  // selected folder into WorkspaceContext once permission is granted.
  const openWorkspaceAndAdd = useCallback(() => {
    const store = ensureFilesystemStore();
    if (!store) {
      const message =
        "File System Access API is not supported in this browser.";
      sendStdout(`${message}\r\n`);
      return message;
    }

    void store
      .openWorkspace()
      .then((workspaceRootUri) => {
        if (!getItems().includes(workspaceRootUri)) {
          addItem(workspaceRootUri);
        }
        sendStdout(`Added local folder: ${workspaceRootUri}\r\n`);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          sendStdout("Picker cancelled.\r\n");
          return;
        }
        sendStdout(`Failed to open folder: ${String(error)}\r\n`);
      });

    return "Opening directory picker...";
  }, [addItem, ensureFilesystemStore, getItems, sendStdout]);

  const kernel = useMemo(
    () =>
      new JSKernel({
        globals: {
          aisreRunners: {
            get: () => {
              const mgr = getRunnersManager();
              const runners = mgr.list();
              if (runners.length === 0) {
                return "No runners configured.";
              }
              return runners
                .map((r) => {
                  const isDefault = r.name === mgr.getDefaultRunnerName();
                  const endpoint =
                    typeof r.endpoint === "string" && r.endpoint.trim() !== ""
                      ? r.endpoint
                      : "<endpoint not set>";
                  return `${r.name}: ${endpoint}${isDefault ? " (default)" : ""}`;
                })
                .join("\n");
            },
            update: (name: string, endpoint: string) => {
              const mgr = getRunnersManager();
              const updated = mgr.update(name, endpoint);
              updateRunner(
                new Runner({
                  name: updated.name,
                  endpoint: updated.endpoint,
                  reconnect: updated.reconnect,
                  interceptors: [],
                }),
              );
              return `Runner ${name} set to ${endpoint}`;
            },
            delete: (name: string) => {
              const mgr = getRunnersManager();
              mgr.delete(name);
              deleteRunner(name);
              return `Runner ${name} deleted`;
            },
            getDefault: () => {
              const mgr = getRunnersManager();
              const defaultName = mgr.getDefaultRunnerName();
              if (!defaultName) {
                return "No default runner set.";
              }
              const runner = mgr.get(defaultName);
              const endpoint =
                runner && typeof runner.endpoint === "string"
                  ? runner.endpoint
                  : "<endpoint not set>";
              return `Default runner: ${defaultName} (${endpoint})`;
            },
            setDefault: (name: string) => {
              const mgr = getRunnersManager();
              const runner = mgr.get(name);
              if (!runner) {
                return `Runner ${name} not found`;
              }
              mgr.setDefault(name);
              updateRunner(
                new Runner({
                  name: runner.name,
                  endpoint: runner.endpoint,
                  reconnect: runner.reconnect,
                  interceptors: runner.interceptors,
                }),
              );
              return `Default runner set to ${name}`;
            },
          },
          googleClientManager: {
            get: () => googleClientManager.getOAuthClient(),
            setClientId: (clientId: string) =>
              googleClientManager.setOAuthClient({ clientId }),
            setClientSecret: (clientSecret: string) =>
              googleClientManager.setClientSecret(clientSecret),
            setFromJson: (raw: string) =>
              googleClientManager.setOAuthClientFromJson(raw),
          },
          oidc: {
            get: () => oidcConfigManager.getConfig(),
            getRedirectURI: () => oidcConfigManager.getRedirectURI(),
            getScope: () => oidcConfigManager.getScope(),
            set: (config: Partial<OidcConfig>) =>
              oidcConfigManager.setConfig(config),
            setClientId: (clientId: string) =>
              oidcConfigManager.setClientId(clientId),
            setClientSecret: (clientSecret: string) =>
              oidcConfigManager.setClientSecret(clientSecret),
            setDiscoveryURL: (discoveryUrl: string) =>
              oidcConfigManager.setDiscoveryURL(discoveryUrl),
            setClientToDrive: () => oidcConfigManager.setClientToDrive(),
            setScope: (scope: string) => oidcConfigManager.setScope(scope),
            setGoogleDefaults: () => oidcConfigManager.setGoogleDefaults(),
            getStatus: async () => {
              const authData = await getAuthData();
              if (!authData) {
                sendStdout("Is Authenticated: No\r\n");
                return { isAuthenticated: false };
              }
              let decodedAccessToken: unknown = null;
              let decodedIdToken: unknown = null;
              try {
                decodedAccessToken = jwtDecode(authData.accessToken);
              } catch (error) {
                sendStdout(`Failed to decode access token: ${String(error)}\r\n`);
              }
              try {
                decodedIdToken = jwtDecode(authData.idToken);
              } catch (error) {
                sendStdout(`Failed to decode ID token: ${String(error)}\r\n`);
              }
              const status = {
                isAuthenticated: true,
                isExpired: authData.isExpired(),
                rawAuthData: authData,
                decodedAccessToken,
                decodedIdToken,
                tokenType: authData.tokenType,
                scope: authData.scope,
              };
              const pretty = JSON.stringify(status, null, 2);
              sendStdout(`Is Authenticated: Yes\r\n`);
              sendStdout(`Is Expired: ${status.isExpired ? "Yes" : "No"}\r\n`);
              sendStdout(`${pretty}\r\n`);
              return status;
            },
          },
          credentials: {
            google: googleClientManager,
            oidc: oidcConfigManager,
          },
          help: () => {
            return [
              "Available namespaces:",
              "  explorer        - Manage workspace folders and notebooks",
              "  aisreRunners    - Configure runner endpoints",
              "  oidc            - OIDC/OAuth configuration and auth status",
              "  googleClientManager - Google OAuth client settings",
              "  credentials     - Shorthand for google/oidc credential managers",
              "",
              "Type <namespace>.help() for detailed commands, e.g. explorer.help()",
            ].join("\n");
          },
          explorer: {
            addFolder: (path?: string) => {
              if (path) {
                return "explorer.addFolder() does not accept a path when using the File System Access API.";
              }
              return openWorkspaceAndAdd();
            },
            mountDrive: (driveUrl: string) => {
              if (!driveUrl) {
                return "Usage: explorer.mountDrive(driveUrl)";
              }
              addItem(driveUrl);
              return `Mounted Drive link: ${driveUrl}`;
            },
            openPicker: () => {
              return openWorkspaceAndAdd();
            },
            removeFolder: (uri: string) => {
              if (!uri) {
                return "Usage: explorer.removeFolder(uri)";
              }
              removeItem(uri);
              return `Removed: ${uri}`;
            },
            listFolders: () => {
              const items = getItems();
              if (items.length === 0) {
                return "No folders in workspace.";
              }
              return items.join("\n");
            },
            help: () => {
              return [
                "explorer.addFolder()           - Open the folder picker and mount a local folder",
                "explorer.mountDrive(driveUrl)   - Mount a Google Drive link",
                "explorer.openPicker()           - Alias for explorer.addFolder()",
                "explorer.removeFolder(uri)      - Remove a folder from workspace",
                "explorer.listFolders()          - List all workspace folders",
                "explorer.help()                 - Show this help",
              ].join("\n");
            },
          },
        },
        hooks: {
          onStdout: (data) => {
            sendStdout(data);
          },
          onStderr: (data) => {
            sendStdout(data);
          },
          onExit: (code) => {
            const suffix = code === 0 ? "" : ` (exit code ${code})`;
            sendStdout(`\r\n${suffix ? `Command finished${suffix}` : ""}\r\n${PROMPT}`);
          },
        },
      }),
    [
      addItem,
      defaultRunnerName,
      deleteRunner,
      getItems,
      listRunners,
      ensureFilesystemStore,
      openWorkspaceAndAdd,
      removeItem,
      sendStdout,
      updateRunner,
    ],
  );

  // Line editor state (buffer + cursor index).
  const lineState = useRef<{ buffer: string; cursor: number }>({
    buffer: "",
    cursor: 0,
  });
  const history = useRef<string[]>([]);
  const historyIndex = useRef<number>(-1); // -1 means current line (not history)

  const redrawLine = () => {
    const { buffer, cursor } = lineState.current;
    const promptLen = PROMPT.length;
    sendStdout(`\r${PROMPT}${buffer}${ERASE_TO_END}`);
    // Move cursor to absolute column (1-based)
    sendStdout(MOVE_CURSOR_COL(promptLen + cursor + 1));
  };

  return (
    <div
      id="app-console"
      className="flex flex-col overflow-hidden rounded-md border border-gray-200 bg-[#0f1014] text-white shadow-sm"
    >
      <div
        id="app-console-header"
        className="flex items-center justify-between border-b border-gray-800 bg-black/60 px-3"
      >
        <span className="text-[12px] font-mono font-medium">App Console</span>
        <button
          type="button"
          aria-label={collapsed ? "Expand app console" : "Collapse app console"}
          className="inline-flex h-8 w-8 items-center justify-center rounded bg-black/0 text-[12px] font-mono font-medium text-white hover:bg-black/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black/80"
          style={{ backgroundColor: "transparent" }}
          onClick={() => setCollapsed((prev) => !prev)}
        >
          <span aria-hidden="true">{collapsed ? "▲" : "▼"}</span>
        </button>
      </div>
      <div
        id="app-console-body"
        className={`${collapsed ? "hidden" : "flex"} flex-1 bg-[#0f1014]`}
      >
        <div
          id="app-console-view"
          className="flex-1 min-h-[220px] w-full"
          ref={(el) => {
            if (!el || el.hasChildNodes()) {
              return;
            }
            const elem = document.createElement("console-view") as any;
            elem.style.height = "100%";
            elem.style.width = "100%";
            elem.style.display = "block";

            elemRef.current = elem;

            const ctxBridge = {
              postMessage: (message: any) => {
                if (message?.type === ClientMessages.terminalStdin) {
                  const input = (message.output?.input as string) ?? "";
                  const state = lineState.current;
                  for (let i = 0; i < input.length; i++) {
                    const ch = input[i];

                    // Handle escape sequences (arrow keys)
                    if (ch === "\u001b" && input[i + 1] === "[") {
                      const code = input[i + 2];
                      if (code === "D") {
                        // Left
                        if (state.cursor > 0) {
                          state.cursor -= 1;
                          redrawLine();
                        }
                        i += 2;
                        continue;
                      }
                      if (code === "C") {
                        // Right
                        if (state.cursor < state.buffer.length) {
                          state.cursor += 1;
                          redrawLine();
                        }
                        i += 2;
                        continue;
                      }
                      if (code === "H") {
                        // Home
                        state.cursor = 0;
                        redrawLine();
                        i += 2;
                        continue;
                      }
                      if (code === "F") {
                        // End
                        state.cursor = state.buffer.length;
                        redrawLine();
                        i += 2;
                        continue;
                      }
                      if (code === "A") {
                        // Up: history prev
                        if (history.current.length === 0) {
                          i += 2;
                          continue;
                        }
                        const nextIndex =
                          historyIndex.current < history.current.length - 1
                            ? historyIndex.current + 1
                            : history.current.length - 1;
                        historyIndex.current = nextIndex;
                        state.buffer =
                          history.current[history.current.length - 1 - nextIndex] ?? "";
                        state.cursor = state.buffer.length;
                        redrawLine();
                        i += 2;
                        continue;
                      }
                      if (code === "B") {
                        // Down: history next
                        if (history.current.length === 0) {
                          i += 2;
                          continue;
                        }
                        const nextIndex =
                          historyIndex.current > 0 ? historyIndex.current - 1 : -1;
                        historyIndex.current = nextIndex;
                        if (nextIndex === -1) {
                          state.buffer = "";
                          state.cursor = 0;
                        } else {
                          state.buffer =
                            history.current[history.current.length - 1 - nextIndex] ?? "";
                          state.cursor = state.buffer.length;
                        }
                        redrawLine();
                        i += 2;
                        continue;
                      }
                    }

                    if (ch === "\r" || ch === "\n") {
                      const command = state.buffer.trim();
                      sendStdout("\r\n");
                      if (command.length > 0) {
                        history.current.push(command);
                        historyIndex.current = -1;
                        void kernel.run(command);
                      } else {
                        sendStdout(PROMPT);
                      }
                      state.buffer = "";
                      state.cursor = 0;
                      continue;
                    }

                    if (ch === "\u0008" || ch === "\u007f") {
                      if (state.cursor > 0) {
                        state.buffer =
                          state.buffer.slice(0, state.cursor - 1) +
                          state.buffer.slice(state.cursor);
                        state.cursor -= 1;
                        redrawLine();
                      }
                      continue;
                    }

                    // Ignore other control characters
                    if (ch < " ") {
                      continue;
                    }

                    // Insert printable character at cursor position
                    state.buffer =
                      state.buffer.slice(0, state.cursor) +
                      ch +
                      state.buffer.slice(state.cursor);
                    state.cursor += 1;
                    redrawLine();
                  }
                }
              },
              onDidReceiveMessage: (listener: (message: unknown) => void) => {
                messageListenerRef.current = listener;
                listener({
                  type: ClientMessages.terminalStdout,
                  output: {
                    "runme.dev/id": consoleId,
                    data: `AISRE JS console. Type help() to see available commands.\n${PROMPT}`,
                  },
                } as any);
                return {
                  dispose: () => {},
                };
              },
            } as RendererContext<void>;

            (elem as any).context = ctxBridge;

            elem.setAttribute("id", consoleId);
            elem.setAttribute("buttons", "false");
            elem.setAttribute("initialContent", "");
            elem.setAttribute("theme", "dark");
            elem.setAttribute("fontFamily", "monospace");
            elem.setAttribute("fontSize", "12");
            elem.setAttribute("cursorStyle", "block");
            elem.setAttribute("cursorBlink", "true");
            elem.setAttribute("cursorWidth", "1");
            elem.setAttribute("smoothScrollDuration", "0");
            elem.setAttribute("scrollback", "4000");

            el.appendChild(elem);
          }}
        ></div>
        <pre
          id="app-console-output"
          data-testid="app-console-output"
          className="sr-only"
        >
          {consoleOutput}
        </pre>
      </div>
    </div>
  );
}
