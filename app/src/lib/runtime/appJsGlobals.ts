import { jwtDecode } from "jwt-decode";

import { OidcConfig, oidcConfigManager } from "../../auth/oidcConfig";
import { parser_pb } from "../../runme/client";
import { LOCAL_FOLDER_URI } from "../../storage/local";
import {
  FilesystemNotebookStore,
  isFileSystemAccessSupported,
} from "../../storage/fs";
import { getAuthData } from "../../token";
import {
  disableAppConfigOverridesOnLoad,
  enableAppConfigOverridesOnLoad,
  getDefaultAppConfigUrl,
  isLocalConfigPreferredOnLoad,
  setAppConfig,
  setAppConfigFromYaml,
  setLocalConfigPreferredOnLoad,
} from "../appConfig";
import { agentEndpointManager } from "../agentEndpointManager";
import { aisreClientManager } from "../aisreClientManager";
import {
  deserializeMarkdownToNotebook,
  getImportedFileBytes,
  getImportedFileName,
  getPickedMarkdownSelection,
  pickMarkdownSource,
  registerImportedMarkdownForUri,
  toImportedNotebookName,
} from "../markdownImport";
import { googleClientManager } from "../googleClientManager";
import type { Runner } from "../runner";
import {
  copyDriveNotebookFile,
  createDriveFile,
  listDriveFolderItems,
  saveNotebookAsDriveCopy,
  updateDriveFileBytes,
} from "../driveTransfer";
import { appState } from "./AppState";
import { getCodexProjectManager, type CodexProject } from "./codexProjectManager";
import { type HarnessAdapter, getHarnessManager } from "./harnessManager";
import { responsesDirectConfigManager } from "./responsesDirectConfigManager";
import {
  createNotebooksApi,
  type NotebookDataLike,
  type RunmeConsoleApi,
} from "./runmeConsole";
import { getRunnersManager } from "./runnersManager";
import { getJupyterManager } from "./jupyterManager";

type SendOutput = (data: string) => void;

type RuntimeNotebookStore = {
  create: (parentUri: string, name: string) => Promise<{ uri: string }>;
  save: (uri: string, notebook: parser_pb.Notebook) => Promise<unknown>;
};

type WorkspaceApi = {
  getItems?: () => string[];
  addItem?: (uri: string) => void;
  removeItem?: (uri: string) => void;
};

type RunnerSync = {
  onUpdated?: (runner: Runner) => void;
  onDeleted?: (name: string) => void;
  onDefaultSet?: (name: string) => void;
};

function emitLine(sendOutput: SendOutput | undefined, message: string): void {
  sendOutput?.(`${message}\r\n`);
}

function createRunmeApi(
  runme: RunmeConsoleApi,
  sendOutput: SendOutput | undefined,
): RunmeConsoleApi {
  return {
    getCurrentNotebook: () => runme.getCurrentNotebook(),
    clear: (target?: unknown) => {
      const message = runme.clear(target);
      emitLine(sendOutput, message);
      return message;
    },
    clearOutputs: (target?: unknown) => {
      const message = runme.clearOutputs(target);
      emitLine(sendOutput, message);
      return message;
    },
    runAll: (target?: unknown) => {
      const message = runme.runAll(target);
      emitLine(sendOutput, message);
      return message;
    },
    rerun: (target?: unknown) => {
      const message = runme.rerun(target);
      emitLine(sendOutput, message);
      return message;
    },
    help: () => {
      const message = runme.help();
      emitLine(sendOutput, message);
      return message;
    },
  };
}

function defaultEnsureFilesystemStore(): FilesystemNotebookStore | null {
  if (appState.filesystemStore) {
    return appState.filesystemStore;
  }
  if (!isFileSystemAccessSupported()) {
    return null;
  }
  const store = new FilesystemNotebookStore();
  appState.setFilesystemStore(store);
  return store;
}

export function createAppJsGlobals({
  runme,
  sendOutput,
  resolveNotebookStore,
  ensureFilesystemStore = defaultEnsureFilesystemStore,
  workspace,
  openNotebook,
  runnerSync,
  resolveNotebook,
  listNotebooks,
}: {
  runme: RunmeConsoleApi;
  sendOutput?: SendOutput;
  resolveNotebookStore?: () => RuntimeNotebookStore | null;
  ensureFilesystemStore?: () => FilesystemNotebookStore | null;
  workspace?: WorkspaceApi;
  openNotebook?: (uri: string) => void | Promise<void>;
  runnerSync?: RunnerSync;
  resolveNotebook?: (target?: unknown) => NotebookDataLike | null;
  listNotebooks?: () => NotebookDataLike[];
}) {
  const getWorkspaceItems = () =>
    workspace?.getItems?.() ?? appState.getWorkspaceItems();
  const addWorkspaceItem = (uri: string) => {
    if (workspace?.addItem) {
      workspace.addItem(uri);
      return;
    }
    appState.addWorkspaceItem(uri);
  };
  const removeWorkspaceItem = (uri: string) => {
    if (workspace?.removeItem) {
      workspace.removeItem(uri);
      return;
    }
    appState.removeWorkspaceItem(uri);
  };
  const resolveStore = () => resolveNotebookStore?.() ?? appState.localNotebooks;
  const openNotebookForRuntime = async (uri: string) => {
    if (openNotebook) {
      await openNotebook(uri);
      return;
    }
    await appState.openNotebook(uri);
  };
  const resolveLocalMirrorStore = () => {
    if (!appState.localNotebooks) {
      throw new Error("Local notebook mirror store is not initialized yet.");
    }
    return appState.localNotebooks;
  };

  const runmeApi = createRunmeApi(runme, sendOutput);
  const notebooksApi = createNotebooksApi({
    resolveNotebook: resolveNotebook ?? (() => runme.getCurrentNotebook()),
    listNotebooks,
  });
  const jupyterManager = getJupyterManager();
  const harnessManager = getHarnessManager();
  const codexProjectManager = getCodexProjectManager();
  const responsesDirect = responsesDirectConfigManager;

  const normalizeHarnessAdapter = (
    value: string,
  ): { adapter: HarnessAdapter; warning?: string } => {
    const normalized = (value ?? "").trim().toLowerCase();
    if (normalized === "codex") {
      return { adapter: "codex" };
    }
    if (
      normalized === "responses" ||
      normalized === "response"
    ) {
      return {
        adapter: "responses-direct",
        warning: `Harness adapter "${value}" is deprecated; using "responses-direct" instead.`,
      };
    }
    if (
      normalized === "responses-direct" ||
      normalized === "responses_direct" ||
      normalized === "responsesdirect"
    ) {
      return { adapter: "responses-direct" };
    }
    throw new Error(`Unsupported harness adapter: ${String(value)}`);
  };

  const formatHarness = (
    harness: { name: string; baseUrl: string; adapter: HarnessAdapter },
    options?: { includeDefaultMarker?: boolean },
  ): string => {
    const isDefault =
      options?.includeDefaultMarker === true &&
      harness.name === harnessManager.getDefaultName();
    return `${harness.name}: ${harness.baseUrl} (${harness.adapter})${
      isDefault ? " (default)" : ""
    }`;
  };

  const formatDefaultHarness = (
    harness: { name: string; baseUrl: string; adapter: HarnessAdapter },
  ): string => {
    return `Default harness: ${harness.name} (${harness.baseUrl}, ${harness.adapter})`;
  };

  const parseVectorStores = (value: string[] | string): string[] => {
    if (Array.isArray(value)) {
      return value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry): entry is string => entry.length > 0);
    }
    if (typeof value === "string") {
      return value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    }
    return [];
  };

  const openWorkspaceAndAdd = () => {
    const store = ensureFilesystemStore();
    if (!store) {
      const message = "File System Access API is not supported in this browser.";
      emitLine(sendOutput, message);
      return message;
    }

    void store
      .openWorkspace()
      .then((workspaceRootUri) => {
        if (!getWorkspaceItems().includes(workspaceRootUri)) {
          addWorkspaceItem(workspaceRootUri);
        }
        emitLine(sendOutput, `Added local folder: ${workspaceRootUri}`);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          emitLine(sendOutput, "Picker cancelled.");
          return;
        }
        emitLine(sendOutput, `Failed to open folder: ${String(error)}`);
      });

    return "Opening directory picker...";
  };

  const importMarkdownAndOpen = async () => {
    const store = resolveStore();
    if (!store) {
      emitLine(sendOutput, "Notebook store is not initialized yet.");
      return "Notebook store unavailable.";
    }

    let picked;
    try {
      picked = await pickMarkdownSource();
    } catch (error) {
      const message = `Failed to open markdown picker: ${String(error)}`;
      emitLine(sendOutput, message);
      return message;
    }

    if (!picked) {
      emitLine(sendOutput, "Markdown import cancelled.");
      return "Import cancelled.";
    }

    try {
      const selection = getPickedMarkdownSelection(picked.sourceUri);
      const notebook = await deserializeMarkdownToNotebook(selection);
      const fileName = toImportedNotebookName(picked.name);
      const created = await store.create(LOCAL_FOLDER_URI, fileName);
      await store.save(created.uri, notebook);
      if (!getWorkspaceItems().includes(LOCAL_FOLDER_URI)) {
        addWorkspaceItem(LOCAL_FOLDER_URI);
      }
      await openNotebookForRuntime(created.uri);
      const message = `Imported ${picked.name} as ${fileName}`;
      emitLine(sendOutput, message);
      return message;
    } catch (error) {
      const message = `Failed to import markdown file: ${String(error)}`;
      emitLine(sendOutput, message);
      return message;
    }
  };

  return {
    runme: runmeApi,
    notebooks: notebooksApi,
    runmeRunners: {
      get: () => {
        const mgr = getRunnersManager();
        const runners = mgr.list();
        if (runners.length === 0) {
          return "No runners configured.";
        }
        return runners
          .map((runner) => {
            const isDefault = runner.name === mgr.getDefaultRunnerName();
            const endpoint =
              typeof runner.endpoint === "string" && runner.endpoint.trim() !== ""
                ? runner.endpoint
                : "<endpoint not set>";
            return `${runner.name}: ${endpoint}${isDefault ? " (default)" : ""}`;
          })
          .join("\n");
      },
      update: (name: string, endpoint: string) => {
        const mgr = getRunnersManager();
        const updated = mgr.update(name, endpoint);
        if (runnerSync?.onUpdated) {
          runnerSync.onUpdated(updated);
        } else {
          appState.syncRunnerUpdate(updated);
        }
        return `Runner ${name} set to ${endpoint}`;
      },
      delete: (name: string) => {
        const mgr = getRunnersManager();
        mgr.delete(name);
        if (runnerSync?.onDeleted) {
          runnerSync.onDeleted(name);
        } else {
          appState.syncRunnerDelete(name);
        }
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
        if (runnerSync?.onDefaultSet) {
          runnerSync.onDefaultSet(name);
        } else {
          appState.syncRunnerDefault(name);
        }
        return `Default runner set to ${name}`;
      },
    },
    jupyter: {
      servers: {
        get: async (runnerName: string) => {
          if (!runnerName?.trim()) {
            throw new Error("Usage: jupyter.servers.get(runnerName)");
          }
          try {
            const servers = await jupyterManager.listServers(runnerName);
            const message =
              servers.length === 0
                ? "No Jupyter servers configured."
                : JSON.stringify(servers, null, 2);
            emitLine(sendOutput, message);
            return servers;
          } catch (error) {
            const message = `Failed to list Jupyter servers: ${String(error)}`;
            emitLine(sendOutput, message);
            throw error;
          }
        },
      },
      kernels: {
        start: async (
          runnerName: string,
          serverName: string,
          options?: { kernelSpec?: string; name?: string; path?: string },
        ) => {
          if (!runnerName?.trim() || !serverName?.trim()) {
            throw new Error("Usage: jupyter.kernels.start(runnerName, serverName, options?)");
          }
          try {
            const kernel = await jupyterManager.startKernel(runnerName, serverName, options);
            const message = `Started kernel ${kernel.id} on ${runnerName}/${serverName} (${kernel.name})`;
            emitLine(sendOutput, message);
            emitLine(sendOutput, JSON.stringify(kernel, null, 2));
            return kernel;
          } catch (error) {
            const message = `Failed to start Jupyter kernel: ${String(error)}`;
            emitLine(sendOutput, message);
            throw error;
          }
        },
        get: async (runnerName: string, serverName: string) => {
          if (!runnerName?.trim() || !serverName?.trim()) {
            throw new Error("Usage: jupyter.kernels.get(runnerName, serverName)");
          }
          try {
            const kernels = await jupyterManager.listKernels(runnerName, serverName);
            const message =
              kernels.length === 0
                ? `No kernels running on ${runnerName}/${serverName}.`
                : JSON.stringify(kernels, null, 2);
            emitLine(sendOutput, message);
            return kernels;
          } catch (error) {
            const message = `Failed to list Jupyter kernels: ${String(error)}`;
            emitLine(sendOutput, message);
            throw error;
          }
        },
        stop: async (runnerName: string, serverName: string, kernelNameOrId: string) => {
          if (!runnerName?.trim() || !serverName?.trim() || !kernelNameOrId?.trim()) {
            throw new Error("Usage: jupyter.kernels.stop(runnerName, serverName, kernelNameOrId)");
          }
          try {
            await jupyterManager.stopKernel(runnerName, serverName, kernelNameOrId);
            const message = `Stopped kernel ${kernelNameOrId} on ${runnerName}/${serverName}`;
            emitLine(sendOutput, message);
            return message;
          } catch (error) {
            const message = `Failed to stop Jupyter kernel: ${String(error)}`;
            emitLine(sendOutput, message);
            throw error;
          }
        },
      },
    },
    agent: {
      get: () => {
        const snapshot = agentEndpointManager.getSnapshot();
        const current = snapshot.endpoint?.trim() || "<not set>";
        const defaultEndpoint = snapshot.defaultEndpoint?.trim() || "<not set>";
        const message = `Agent endpoint: ${current}\nDefault agent endpoint: ${defaultEndpoint}`;
        emitLine(sendOutput, message);
        return message;
      },
      update: (endpoint: string) => {
        const trimmed = endpoint?.trim();
        if (!trimmed) {
          const message = "Usage: agent.update(endpoint)";
          emitLine(sendOutput, message);
          return message;
        }
        agentEndpointManager.set(trimmed);
        aisreClientManager.setDefault({ baseUrl: trimmed });
        const message = `Agent endpoint set to ${trimmed}`;
        emitLine(sendOutput, message);
        return message;
      },
      setDefault: () => {
        const defaultEndpoint = agentEndpointManager.reset();
        if (!defaultEndpoint) {
          const message = "Default agent endpoint is not configured.";
          emitLine(sendOutput, message);
          return message;
        }
        aisreClientManager.setDefault({ baseUrl: defaultEndpoint });
        const message = `Agent endpoint reset to default (${defaultEndpoint})`;
        emitLine(sendOutput, message);
        return message;
      },
      help: () => {
        const message = [
          "agent.get()                 - Show current and default agent endpoint",
          "agent.update(endpoint)      - Set the active agent endpoint",
          "agent.setDefault()          - Reset agent endpoint to app default",
          "agent.help()                - Show this help",
        ].join("\n");
        emitLine(sendOutput, message);
        return message;
      },
    },
    googleClientManager: {
      get: () => googleClientManager.getOAuthClient(),
      setOAuthClient: (config: {
        clientId?: string;
        clientSecret?: string;
        authFlow?: "implicit" | "pkce";
        authUxMode?: "popup" | "redirect";
      }) => googleClientManager.setOAuthClient(config),
      setClientId: (clientId: string) =>
        googleClientManager.setOAuthClient({ clientId }),
      setClientSecret: (clientSecret: string) =>
        googleClientManager.setClientSecret(clientSecret),
      setAuthFlow: (authFlow: "implicit" | "pkce") =>
        googleClientManager.setAuthFlow(authFlow),
      setAuthUxMode: (authUxMode: "popup" | "redirect") =>
        googleClientManager.setAuthUxMode(authUxMode),
      setFromJson: (raw: string) =>
        googleClientManager.setOAuthClientFromJson(raw),
    },
    oidc: {
      get: () => oidcConfigManager.getConfig(),
      getRedirectURI: () => oidcConfigManager.getRedirectURI(),
      getScope: () => oidcConfigManager.getScope(),
      set: (config: Partial<OidcConfig>) => oidcConfigManager.setConfig(config),
      setClientId: (clientId: string) => oidcConfigManager.setClientId(clientId),
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
          emitLine(sendOutput, "Is Authenticated: No");
          return { isAuthenticated: false };
        }
        let decodedAccessToken: unknown = null;
        let decodedIdToken: unknown = null;
        try {
          decodedAccessToken = jwtDecode(authData.accessToken);
        } catch (error) {
          emitLine(sendOutput, `Failed to decode access token: ${String(error)}`);
        }
        try {
          if (authData.idToken) {
            decodedIdToken = jwtDecode(authData.idToken);
          }
        } catch (error) {
          emitLine(sendOutput, `Failed to decode ID token: ${String(error)}`);
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
        emitLine(sendOutput, "Is Authenticated: Yes");
        emitLine(sendOutput, `Is Expired: ${status.isExpired ? "Yes" : "No"}`);
        emitLine(sendOutput, JSON.stringify(status, null, 2));
        return status;
      },
    },
    credentials: {
      google: googleClientManager,
      oidc: oidcConfigManager,
      openai: {
        get: () => responsesDirect.getSnapshot(),
        setAuthMethod: (authMethod: string) => {
          return responsesDirect.setAuthMethod(authMethod);
        },
        setOpenAIOrganization: (openaiOrganization: string) => {
          return responsesDirect.setOpenAIOrganization(openaiOrganization);
        },
        setOpenAIProject: (openaiProject: string) => {
          return responsesDirect.setOpenAIProject(openaiProject);
        },
        setVectorStores: (vectorStores: string[] | string) => {
          return responsesDirect.setVectorStores(parseVectorStores(vectorStores));
        },
        setAPIKey: (apiKey: string) => {
          return responsesDirect.setAPIKey(apiKey);
        },
        clearAPIKey: () => {
          return responsesDirect.clearAPIKey();
        },
      },
    },
    app: {
      getDefaultConfigUrl: () => getDefaultAppConfigUrl(),
      isLocalConfigPreferredOnLoad: () => isLocalConfigPreferredOnLoad(),
      setLocalConfigPreferredOnLoad: (preferLocal: boolean) => {
        const applied = setLocalConfigPreferredOnLoad(Boolean(preferLocal));
        const message = `App config load precedence set to ${applied ? "local storage" : "app-config"}`;
        emitLine(sendOutput, message);
        return applied;
      },
      disableConfigOverridesOnLoad: () => {
        const applied = disableAppConfigOverridesOnLoad();
        emitLine(sendOutput, "App config overrides on load disabled.");
        return applied;
      },
      enableConfigOverridesOnLoad: () => {
        const applied = enableAppConfigOverridesOnLoad();
        emitLine(sendOutput, "App config overrides on load enabled.");
        return applied;
      },
      openNotebook: async (uri: string) => {
        if (!uri?.trim()) {
          throw new Error("Usage: app.openNotebook(localUri)");
        }
        await openNotebookForRuntime(uri);
        emitLine(sendOutput, `Opened notebook ${uri}`);
        return uri;
      },
      setConfig: async (url?: string) => {
        emitLine(sendOutput, "Fetching app config...");
        try {
          const applied = await setAppConfig(url);
          if (applied.warnings.length > 0) {
            applied.warnings.forEach((warning) => {
              emitLine(sendOutput, `Warning: ${warning}`);
            });
          }
          emitLine(sendOutput, "App config applied.");
          return applied;
        } catch (error) {
          const message = `Failed to apply app config: ${String(error)}`;
          emitLine(sendOutput, message);
          throw error;
        }
      },
      setConfigFromYaml: async (yamlText: string, source?: string) => {
        emitLine(sendOutput, "Applying app config YAML...");
        try {
          const applied = setAppConfigFromYaml(yamlText, source);
          if (applied.warnings.length > 0) {
            applied.warnings.forEach((warning) => {
              emitLine(sendOutput, `Warning: ${warning}`);
            });
          }
          emitLine(sendOutput, "App config applied.");
          return applied;
        } catch (error) {
          const message = `Failed to apply app config YAML: ${String(error)}`;
          emitLine(sendOutput, message);
          throw error;
        }
      },
      harness: {
        get: () => {
          const harnesses = harnessManager.list();
          if (harnesses.length === 0) {
            const message = "No harnesses configured.";
            emitLine(sendOutput, message);
            return message;
          }
          const message = harnesses
            .map((harness) =>
              formatHarness(harness, { includeDefaultMarker: true }),
            )
            .join("\n");
          emitLine(sendOutput, message);
          return message;
        },
        update: (name: string, baseUrl: string, adapter: string) => {
          const normalized = normalizeHarnessAdapter(adapter);
          const updated = harnessManager.update(
            name,
            baseUrl,
            normalized.adapter,
          );
          const message = normalized.warning
            ? `Harness ${updated.name} set to ${updated.baseUrl} (${updated.adapter})\nWarning: ${normalized.warning}`
            : `Harness ${updated.name} set to ${updated.baseUrl} (${updated.adapter})`;
          emitLine(sendOutput, message);
          return message;
        },
        delete: (name: string) => {
          harnessManager.delete(name);
          const message = `Harness ${name} deleted`;
          emitLine(sendOutput, message);
          return message;
        },
        getDefault: () => {
          const message = formatDefaultHarness(harnessManager.getDefault());
          emitLine(sendOutput, message);
          return message;
        },
        setDefault: (name: string) => {
          harnessManager.setDefault(name);
          const message = `Default harness set to ${name}`;
          emitLine(sendOutput, message);
          return message;
        },
        getActiveChatkitUrl: () => {
          const active = harnessManager.getDefault();
          const chatkitUrl = harnessManager.resolveChatkitUrl(active);
          const message = `Active ChatKit URL: ${chatkitUrl} (${active.name}, ${active.adapter})`;
          emitLine(sendOutput, message);
          return message;
        },
      },
      codex: {
        project: {
          list: () => {
            const projects = codexProjectManager.list();
            if (projects.length === 0) {
              const message = "No codex projects configured.";
              emitLine(sendOutput, message);
              return message;
            }
            const defaultProjectId = codexProjectManager.getDefaultId();
            const message = projects
              .map((project) => {
                const isDefault = project.id === defaultProjectId;
                return `${project.id}: ${project.name} (${project.cwd}, model=${project.model}, sandbox=${project.sandboxPolicy}, approval=${project.approvalPolicy})${
                  isDefault ? " (default)" : ""
                }`;
              })
              .join("\n");
            emitLine(sendOutput, message);
            return message;
          },
          create: (
            name: string,
            cwd: string,
            model: string,
            sandboxPolicy: string,
            approvalPolicy: string,
            personality: string,
          ) => {
            const created = codexProjectManager.create(
              name,
              cwd,
              model,
              sandboxPolicy,
              approvalPolicy,
              personality,
            );
            const message = `Codex project ${created.name} created (${created.id})`;
            emitLine(sendOutput, message);
            return message;
          },
          update: (id: string, patch: Partial<CodexProject>) => {
            const updated = codexProjectManager.update(id, patch);
            const message = `Codex project ${updated.name} updated (${updated.id})`;
            emitLine(sendOutput, message);
            return message;
          },
          delete: (id: string) => {
            codexProjectManager.delete(id);
            const message = `Codex project ${id} deleted`;
            emitLine(sendOutput, message);
            return message;
          },
          getDefault: () => {
            const project = codexProjectManager.getDefault();
            const message = `Default codex project: ${project.name} (${project.id}, cwd=${project.cwd}, model=${project.model})`;
            emitLine(sendOutput, message);
            return message;
          },
          setDefault: (id: string) => {
            codexProjectManager.setDefault(id);
            const message = `Default codex project set to ${id}`;
            emitLine(sendOutput, message);
            return message;
          },
        },
      },
      responsesDirect: {
        get: () => responsesDirect.getSnapshot(),
        setAuthMethod: (authMethod: string) => {
          return responsesDirect.setAuthMethod(authMethod);
        },
        setOpenAIOrganization: (openaiOrganization: string) => {
          return responsesDirect.setOpenAIOrganization(openaiOrganization);
        },
        setOpenAIProject: (openaiProject: string) => {
          return responsesDirect.setOpenAIProject(openaiProject);
        },
        setVectorStores: (vectorStores: string[] | string) => {
          return responsesDirect.setVectorStores(parseVectorStores(vectorStores));
        },
        setAPIKey: (apiKey: string) => {
          return responsesDirect.setAPIKey(apiKey);
        },
        clearAPIKey: () => {
          return responsesDirect.clearAPIKey();
        },
      },
    },
    help: () => {
      const message = [
        "Available namespaces:",
        "  runme           - Notebook helpers (run all, clear outputs)",
        "  explorer        - Manage workspace folders and notebooks",
        "  runmeRunners    - Configure runner endpoints",
        "  jupyter         - Manage Jupyter servers and kernels",
        "  agent           - Configure assistant/API agent endpoint",
        "  files           - Import local files and access their bytes",
        "  drive           - List/create/copy/update Google Drive notebook files",
        "  oidc            - OIDC/OAuth configuration and auth status",
        "  googleClientManager - Google OAuth client settings",
        "  app             - App-level configuration helpers",
        "  credentials     - Shorthand for google/oidc/openai credential managers",
        "",
        "Type <namespace>.help() for detailed commands, e.g. explorer.help()",
      ].join("\n");
      emitLine(sendOutput, message);
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
        addWorkspaceItem(driveUrl);
        return `Mounted Drive link: ${driveUrl}`;
      },
      openPicker: () => openWorkspaceAndAdd(),
      importMarkdown: () => {
        void importMarkdownAndOpen();
        return "Opening markdown file picker...";
      },
      removeFolder: (uri: string) => {
        if (!uri) {
          return "Usage: explorer.removeFolder(uri)";
        }
        removeWorkspaceItem(uri);
        return `Removed: ${uri}`;
      },
      listFolders: () => {
        const items = getWorkspaceItems();
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
          emitLine(sendOutput, "Markdown pick cancelled.");
          return null;
        }
        emitLine(sendOutput, `Picked ${picked.name} -> ${picked.sourceUri}`);
        return picked;
      },
      importMarkdown: async (sourceUri: string, targetFolderUri?: string) => {
        if (!sourceUri) {
          throw new Error(
            "Usage: files.importMarkdown(sourceUri, targetFolderUri?)",
          );
        }
        const selection = getPickedMarkdownSelection(sourceUri);
        const store = resolveStore();
        if (!store) {
          throw new Error("Notebook store is not initialized yet.");
        }
        const notebook = await deserializeMarkdownToNotebook(selection);
        const fileName = toImportedNotebookName(selection.name);
        const parentUri = targetFolderUri || LOCAL_FOLDER_URI;
        const created = await store.create(parentUri, fileName);
        await store.save(created.uri, notebook);
        if (!getWorkspaceItems().includes(parentUri)) {
          addWorkspaceItem(parentUri);
        }
        if (!getWorkspaceItems().includes(LOCAL_FOLDER_URI)) {
          addWorkspaceItem(LOCAL_FOLDER_URI);
        }
        registerImportedMarkdownForUri(created.uri, selection);
        emitLine(sendOutput, `Imported ${selection.name} -> ${created.uri}`);
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
      list: async (folder: string) => {
        const items = await listDriveFolderItems(folder);
        emitLine(sendOutput, `Listed ${items.length} Drive item(s)`);
        return items;
      },
      create: async (folder: string, name: string) => {
        const id = await createDriveFile(folder, name);
        emitLine(sendOutput, `Created Drive file ${id}`);
        return id;
      },
      update: async (idOrUri: string, bytes: Uint8Array) => {
        const id = await updateDriveFileBytes(idOrUri, bytes);
        emitLine(sendOutput, `Updated Drive file ${id}`);
        return id;
      },
      saveAsCurrentNotebook: async (folder: string, name: string) => {
        if (!folder?.trim() || !name?.trim()) {
          throw new Error(
            "Usage: drive.saveAsCurrentNotebook(folderIdOrUri, fileName)",
          );
        }
        const notebook = runme.getCurrentNotebook();
        if (!notebook) {
          throw new Error("No active notebook handle available.");
        }
        const result = await saveNotebookAsDriveCopy(
          notebook.getNotebook(),
          folder,
          name,
        );
        emitLine(
          sendOutput,
          `Saved notebook as ${result.fileName} (${result.fileId}) and switched to ${result.localUri}`,
        );
        return result;
      },
      copyNotebook: async (
        sourceIdOrUri: string,
        targetFolder: string,
        targetName?: string,
      ) => {
        const result = await copyDriveNotebookFile(
          sourceIdOrUri,
          targetFolder,
          targetName,
        );
        emitLine(
          sendOutput,
          `Copied notebook ${result.sourceUri} -> ${result.targetUri}`,
        );
        return result;
      },
      listPendingSync: async () => {
        const localStore = resolveLocalMirrorStore();
        const pending = await localStore.listDriveBackedFilesNeedingSync();
        if (pending.length === 0) {
          emitLine(sendOutput, "No Drive-backed notebooks pending sync.");
          return pending;
        }
        emitLine(
          sendOutput,
          `Drive-backed notebooks pending sync (${pending.length}):`,
        );
        pending.forEach((uri) => emitLine(sendOutput, `- ${uri}`));
        return pending;
      },
      requeuePendingSync: async () => {
        const localStore = resolveLocalMirrorStore();
        const enqueued = await localStore.enqueueDriveBackedFilesNeedingSync();
        if (enqueued.length === 0) {
          emitLine(sendOutput, "No Drive-backed notebooks required requeue.");
          return enqueued;
        }
        emitLine(
          sendOutput,
          `Requeued Drive-backed notebooks for sync (${enqueued.length}):`,
        );
        enqueued.forEach((uri) => emitLine(sendOutput, `- ${uri}`));
        return enqueued;
      },
      help: () => {
        return [
          "drive.list(folder)            - List Drive items in a folder",
          "drive.create(folder, name)     - Create a Drive file in folder; returns file id",
          "drive.update(id, bytes)        - Write UTF-8 bytes to a Drive file id/URI",
          "drive.saveAsCurrentNotebook(folder, fileName) - Save current notebook to Drive and switch current doc",
          "drive.copyNotebook(source, targetFolder, fileName?) - Copy a notebook file to another Drive folder",
          "drive.listPendingSync()        - List Drive-backed local notebooks that currently need sync",
          "drive.requeuePendingSync()     - Requeue all Drive-backed local notebooks that need sync",
          "drive.help()                   - Show this help",
        ].join("\n");
      },
    },
  };
}
