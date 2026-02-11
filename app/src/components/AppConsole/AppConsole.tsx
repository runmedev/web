import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChevronUpIcon, ChevronDownIcon } from "@heroicons/react/20/solid";
import { ClientMessages, setContext } from "@runmedev/renderers";
import type { RendererContext } from "vscode-notebook-renderer";

import { JSKernel } from "../../lib/runtime/jsKernel";
import { useRunners } from "../../contexts/RunnersContext";
import { useWorkspace } from "../../contexts/WorkspaceContext";
import { useFilesystemStore } from "../../contexts/FilesystemStoreContext";
import { useCurrentDoc } from "../../contexts/CurrentDocContext";
import { useNotebookContext } from "../../contexts/NotebookContext";
import { useNotebookStore } from "../../contexts/NotebookStoreContext";
import { appState } from "../../lib/runtime/AppState";
import {
  FilesystemNotebookStore,
  isFileSystemAccessSupported,
} from "../../storage/fs";
import { LOCAL_FOLDER_URI } from "../../storage/local";
import { Runner } from "../../lib/runner";
import { getRunnersManager } from "../../lib/runtime/runnersManager";
import {
  createRunmeConsoleApi,
  type NotebookDataLike,
} from "../../lib/runtime/runmeConsole";
import { googleClientManager } from "../../lib/googleClientManager";
import { oidcConfigManager } from "../../auth/oidcConfig";
import type { OidcConfig } from "../../auth/oidcConfig";
import { getAuthData } from "../../token";
import { jwtDecode } from "jwt-decode";
import { getDefaultAppConfigUrl, setAppConfig } from "../../lib/appConfig";
import {
  deserializeMarkdownToNotebook,
  getPickedMarkdownSelection,
  getImportedFileBytes,
  getImportedFileName,
  pickMarkdownSource,
  registerImportedMarkdownForUri,
  toImportedNotebookName,
} from "../../lib/markdownImport";
import { createDriveFile, updateDriveFileBytes } from "../../lib/driveTransfer";

const PROMPT = "> ";
const ERASE_TO_END = "\u001b[K";
const MOVE_CURSOR_COL = (col: number) => `\u001b[${col}G`;
const STORAGE_KEY = "runme.appConsoleCollapsed";
const LEGACY_STORAGE_KEY = "aisre.appConsoleCollapsed";
const MAX_CONSOLE_OUTPUT = 8000;

/**
 * AppConsole wired to JSKernel. Input entered in console-view is executed
 * via JSKernel and stdout/stderr are written back to the terminal.
 */
export default function AppConsole({ showHeader = true }: { showHeader?: boolean }) {
  const elemRef = useRef<any>(null);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return false;
    }
    try {
      const stored =
        localStorage.getItem(STORAGE_KEY) ??
        localStorage.getItem(LEGACY_STORAGE_KEY);
      return stored === "true";
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
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch (error) {
      console.error("Failed to persist console collapse state", error);
    }
  }, [collapsed]);

  const consoleId = useMemo(
    () => `console-${Math.random().toString(36).substring(2, 9)}`,
    [],
  );
  const { listRunners, updateRunner, deleteRunner, defaultRunnerName, setDefaultRunner } =
    useRunners();
  // WorkspaceContext provides the persisted list of workspace URIs so we can
  // mount/unmount folders from the App Console without drilling props.
  const { getItems, addItem, removeItem } = useWorkspace();
  const { getCurrentDoc, setCurrentDoc } = useCurrentDoc();
  const { getNotebookData, useNotebookList } = useNotebookContext();
  const openNotebooks = useNotebookList();
  // FilesystemStoreContext owns the File System Access API store instance that
  // actually opens folders and produces fs:// workspace URIs.
  const { fsStore, setFsStore } = useFilesystemStore();
  const { store: notebookStore } = useNotebookStore();
  const resolveNotebookStore = useCallback(() => {
    return notebookStore ?? appState.localNotebooks;
  }, [notebookStore]);

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

  const getVisibleNotebookUri = useCallback((): string | null => {
    const activePanel = document.querySelector<HTMLElement>(
      '[data-document-id][data-state="active"]',
    );
    const uri = activePanel?.dataset.documentId;
    if (!uri || uri.trim() === "") {
      return null;
    }
    return uri;
  }, []);

  const resolveNotebookData = useCallback(
    (target?: unknown): NotebookDataLike | null => {
      if (target && typeof target === "object") {
        const candidate = target as Partial<NotebookDataLike>;
        if (
          typeof candidate.getUri === "function" &&
          typeof candidate.getName === "function" &&
          typeof candidate.getNotebook === "function" &&
          typeof candidate.updateCell === "function" &&
          typeof candidate.getCell === "function"
        ) {
          return candidate as NotebookDataLike;
        }
      }

      if (typeof target === "string" && target.trim() !== "") {
        return getNotebookData(target) ?? null;
      }

      const currentUri = getCurrentDoc();
      if (currentUri) {
        const currentNotebook = getNotebookData(currentUri);
        if (currentNotebook) {
          return currentNotebook;
        }
      }

      const visibleUri = openNotebooks[0]?.uri;
      const activeUri = getVisibleNotebookUri() ?? visibleUri;
      if (!activeUri) {
        return null;
      }
      return getNotebookData(activeUri) ?? null;
    },
    [getCurrentDoc, getNotebookData, getVisibleNotebookUri, openNotebooks],
  );

  const runme = useMemo(
    () =>
      createRunmeConsoleApi({
        resolveNotebook: resolveNotebookData,
      }),
    [resolveNotebookData],
  );

  const importMarkdownAndOpen = useCallback(async () => {
    const store = resolveNotebookStore();
    if (!store) {
      sendStdout("Notebook store is not initialized yet.\r\n");
      return "Notebook store unavailable.";
    }

    let selection;
    try {
      selection = await pickMarkdownSource();
    } catch (error) {
      const message = `Failed to open markdown picker: ${String(error)}`;
      sendStdout(`${message}\r\n`);
      return message;
    }

    if (!selection) {
      sendStdout("Markdown import cancelled.\r\n");
      return "Import cancelled.";
    }

    try {
      const notebook = await deserializeMarkdownToNotebook(selection);
      const fileName = toImportedNotebookName(selection.name);
      const created = await store.create(LOCAL_FOLDER_URI, fileName);
      await store.save(created.uri, notebook);
      if (!getItems().includes(LOCAL_FOLDER_URI)) {
        addItem(LOCAL_FOLDER_URI);
      }
      setCurrentDoc(created.uri);
      const message = `Imported ${selection.name} as ${fileName}`;
      sendStdout(`${message}\r\n`);
      return message;
    } catch (error) {
      const message = `Failed to import markdown file: ${String(error)}`;
      sendStdout(`${message}\r\n`);
      return message;
    }
  }, [addItem, getItems, resolveNotebookStore, sendStdout, setCurrentDoc]);

  const kernel = useMemo(
    () =>
      new JSKernel({
        globals: {
          runme: {
            getCurrentNotebook: () => {
              return runme.getCurrentNotebook();
            },
            clear: (target?: unknown) => {
              const message = runme.clear(target);
              sendStdout(`${message}\r\n`);
              return message;
            },
            clearOutputs: (target?: unknown) => {
              const message = runme.clearOutputs(target);
              sendStdout(`${message}\r\n`);
              return message;
            },
            runAll: (target?: unknown) => {
              const message = runme.runAll(target);
              sendStdout(`${message}\r\n`);
              return message;
            },
            rerun: (target?: unknown) => {
              const message = runme.rerun(target);
              sendStdout(`${message}\r\n`);
              return message;
            },
            help: () => {
              const message = runme.help();
              sendStdout(`${message}\r\n`);
              return message;
            },
          },
          runmeRunners: {
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
              // Keep React state and singleton manager in sync for default runner.
              setDefaultRunner(name);
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
          app: {
            getDefaultConfigUrl: () => getDefaultAppConfigUrl(),
            setConfig: async (url?: string) => {
              sendStdout("Fetching app config...\r\n");
              try {
                const applied = await setAppConfig(url);
                if (applied.warnings.length > 0) {
                  applied.warnings.forEach((warning) => {
                    sendStdout(`Warning: ${warning}\r\n`);
                  });
                }
                sendStdout("App config applied.\r\n");
                return applied;
              } catch (error) {
                const message = `Failed to apply app config: ${String(error)}`;
                sendStdout(`${message}\r\n`);
                throw error;
              }
            },
          },
          help: () => {
            const message = [
              "Available namespaces:",
              "  runme           - Notebook helpers (run all, clear outputs)",
              "  explorer        - Manage workspace folders and notebooks",
              "  runmeRunners    - Configure runner endpoints",
              "  files           - Import local files and access their bytes",
              "  drive           - Create/update Google Drive files",
              "  oidc            - OIDC/OAuth configuration and auth status",
              "  googleClientManager - Google OAuth client settings",
              "  app             - App-level configuration helpers",
              "  credentials     - Shorthand for google/oidc credential managers",
              "",
              "Type <namespace>.help() for detailed commands, e.g. explorer.help()",
            ].join("\n");
            sendStdout(`${message}\r\n`);
            return message;
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
            importMarkdown: () => {
              void importMarkdownAndOpen();
              return "Opening markdown file picker...";
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
                "explorer.importMarkdown()       - Import a local Markdown file as a notebook",
                "explorer.removeFolder(uri)      - Remove a folder from workspace",
                "explorer.listFolders()          - List all workspace folders",
                "explorer.help()                 - Show this help",
              ].join("\n");
            },
          },
          files: {
            pickMarkdown: async () => {
              const picked = await pickMarkdownSource();
              if (!picked) {
                sendStdout("Markdown pick cancelled.\r\n");
                return null;
              }
              sendStdout(`Picked ${picked.name} -> ${picked.sourceUri}\r\n`);
              return picked;
            },
            importMarkdown: async (sourceUri: string, targetFolderUri?: string) => {
              if (!sourceUri) {
                throw new Error(
                  "Usage: files.importMarkdown(sourceUri, targetFolderUri?)",
                );
              }
              const selection = getPickedMarkdownSelection(sourceUri);
              const store = resolveNotebookStore();
              if (!store) {
                throw new Error("Notebook store is not initialized yet.");
              }
              const notebook = await deserializeMarkdownToNotebook(selection);
              const fileName = toImportedNotebookName(selection.name);
              const parentUri = targetFolderUri || LOCAL_FOLDER_URI;
              const created = await store.create(parentUri, fileName);
              await store.save(created.uri, notebook);
              if (!getItems().includes(parentUri)) {
                addItem(parentUri);
              }
              if (!getItems().includes(LOCAL_FOLDER_URI)) {
                addItem(LOCAL_FOLDER_URI);
              }
              registerImportedMarkdownForUri(created.uri, selection);
              sendStdout(`Imported ${selection.name} -> ${created.uri}\r\n`);
              return {
                localUri: created.uri,
                sourceUri,
                name: selection.name,
                notebookName: fileName,
                size: selection.bytes.byteLength,
              };
            },
            getBytes: (localUri: string) => {
              if (!localUri) {
                throw new Error("Usage: files.getBytes(localUri)");
              }
              return getImportedFileBytes(localUri);
            },
            getName: (localUri: string) => {
              if (!localUri) {
                throw new Error("Usage: files.getName(localUri)");
              }
              return getImportedFileName(localUri);
            },
            help: () => {
              return [
                "files.pickMarkdown()           - Open local picker and return sourceUri",
                "files.importMarkdown(sourceUri, targetFolderUri?) - Import picked markdown into local notebooks",
                "files.getBytes(localUri)       - Return imported Markdown Uint8Array bytes for a local notebook URI",
                "files.getName(localUri)        - Return original filename for imported file URI",
                "files.help()                   - Show this help",
              ].join("\n");
            },
          },
          drive: {
            create: async (folder: string, name: string) => {
              const id = await createDriveFile(folder, name);
              sendStdout(`Created Drive file ${id}\r\n`);
              return id;
            },
            update: async (idOrUri: string, bytes: Uint8Array) => {
              const id = await updateDriveFileBytes(idOrUri, bytes);
              sendStdout(`Updated Drive file ${id}\r\n`);
              return id;
            },
            help: () => {
              return [
                "drive.create(folder, name)     - Create a Drive file in folder; returns file id",
                "drive.update(id, bytes)        - Write UTF-8 bytes to a Drive file id/URI",
                "drive.help()                   - Show this help",
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
      getCurrentDoc,
      getItems,
      getNotebookData,
      listRunners,
      resolveNotebookStore,
      ensureFilesystemStore,
      importMarkdownAndOpen,
      openWorkspaceAndAdd,
      removeItem,
      runme,
      sendStdout,
      setDefaultRunner,
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

  const isBodyHidden = showHeader && collapsed;

  return (
    <div
      id="app-console"
      className="flex flex-col overflow-hidden rounded-nb-md border border-nb-cell-border bg-[#0f1014] text-white shadow-nb-sm"
    >
      {showHeader && (
        <div
          id="app-console-header"
          className="flex items-center justify-between border-b border-nb-tray-border bg-[#1a1a2e] px-3"
        >
          <span className="text-[12.6px] font-mono font-medium">App Console</span>
          <button
            type="button"
            aria-label={collapsed ? "Expand app console" : "Collapse app console"}
            className="inline-flex h-8 w-8 items-center justify-center rounded bg-black/0 text-[12.6px] font-mono font-medium text-white hover:bg-black/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black/80"
            style={{ backgroundColor: "transparent" }}
            onClick={() => setCollapsed((prev) => !prev)}
          >
            {collapsed ? <ChevronUpIcon className="h-4 w-4" /> : <ChevronDownIcon className="h-4 w-4" />}
          </button>
        </div>
      )}
      <div
        id="app-console-body"
        className={`${isBodyHidden ? "hidden" : "flex"} flex-1 bg-[#0f1014]`}
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
                    data: `runme JS console. Type help() to see available commands.\n${PROMPT}`,
                  },
                } as any);
                return {
                  dispose: () => {},
                };
              },
            } as RendererContext<void>;

            const activateConsoleContext = () => {
              setContext(ctxBridge);
            };

            // console-view currently resolves messaging through the renderer
            // global context, so ensure this bridge is active for app-console input.
            activateConsoleContext();
            (elem as any).context = ctxBridge;
            elem.addEventListener("pointerdown", activateConsoleContext);
            elem.addEventListener("focusin", activateConsoleContext);
            // Some terminal events (for example selection/annotation updates)
            // can be emitted before focus is moved to the element. Re-arming
            // the bridge on keydown keeps AppConsole interactive even when
            // another console recently replaced the shared renderer context.
            elem.addEventListener("keydown", activateConsoleContext, true);

            elem.setAttribute("id", consoleId);
            elem.setAttribute("buttons", "false");
            elem.setAttribute("initialContent", "");
            elem.setAttribute("theme", "dark");
            elem.setAttribute("fontFamily", "Fira Mono, monospace");
            elem.setAttribute("fontSize", "12.6");
            elem.setAttribute("cursorStyle", "block");
            elem.setAttribute("cursorBlink", "true");
            elem.setAttribute("cursorWidth", "1");
            elem.setAttribute("smoothScrollDuration", "0");
            elem.setAttribute("scrollback", "4000");

            el.appendChild(elem);
            // Re-apply once after attachment so the global messaging context is
            // deterministic even if another component changed it during mount.
            queueMicrotask(activateConsoleContext);
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
