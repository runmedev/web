import { getRunnersManager, DEFAULT_RUNNER_PLACEHOLDER } from "./runnersManager";
import { getAuthData } from "../../token";
import { getBrowserAdapter } from "../../browserAdapter.client";

export type JupyterServerRecord = {
  name: string;
  runner: string;
  base_url: string;
  has_token: boolean;
};

export type JupyterKernelModel = {
  id: string;
  name: string;
  last_activity?: string;
  execution_state?: string;
  connections?: number;
};

export type JupyterKernelOption = {
  key: string;
  label: string;
  serverName: string;
  kernelId: string;
  kernelName: string;
};

type KernelCacheEntry = {
  model: JupyterKernelModel;
  label: string;
};

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function runnerEndpointToHttpBase(runnerEndpoint: string): string {
  const parsed = new URL(runnerEndpoint);
  if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  } else if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function buildJupyterChannelsWebSocketURL(args: {
  runnerEndpoint: string;
  serverName: string;
  kernelId: string;
  authorization?: string;
}): string {
  const parsed = new URL(args.runnerEndpoint);
  if (parsed.protocol === "http:") {
    parsed.protocol = "ws:";
  } else if (parsed.protocol === "https:") {
    parsed.protocol = "wss:";
  }
  parsed.pathname = `/v1/jupyter/servers/${encodePathSegment(args.serverName)}/kernels/${encodePathSegment(args.kernelId)}/channels`;
  parsed.search = "";
  if (args.authorization && args.authorization.trim()) {
    parsed.searchParams.set("authorization", args.authorization.trim());
  }
  parsed.hash = "";
  return parsed.toString();
}

class JupyterManager {
  private static singleton: JupyterManager | null = null;

  private version = 0;
  private listeners = new Set<() => void>();
  private serversByName = new Map<string, JupyterServerRecord>();
  private kernelsByServer = new Map<string, KernelCacheEntry[]>();
  private kernelAliases = new Map<string, string>();
  private ensureRunnerPromises = new Map<string, Promise<void>>();

  static getInstance(): JupyterManager {
    if (!JupyterManager.singleton) {
      JupyterManager.singleton = new JupyterManager();
    }
    return JupyterManager.singleton;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getVersion(): number {
    return this.version;
  }

  private bumpVersion(): void {
    this.version += 1;
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        console.error("Jupyter manager listener failed", error);
      }
    });
  }

  private resolveRunnerEndpoint(runnerName?: string): string {
    const mgr = getRunnersManager();
    const normalizedRunnerName = runnerName?.trim();
    const effectiveName =
      !normalizedRunnerName ||
      normalizedRunnerName === DEFAULT_RUNNER_PLACEHOLDER
        ? mgr.getDefaultRunnerName() ?? ""
        : normalizedRunnerName;
    const runner = effectiveName ? mgr.getWithFallback(effectiveName) : undefined;
    if (!runner?.endpoint) {
      throw new Error("No runner endpoint configured.");
    }
    return runner.endpoint;
  }

  private getServerRunnerName(serverName: string): string {
    const server = this.serversByName.get(serverName);
    if (!server?.runner) {
      const mgr = getRunnersManager();
      return mgr.getDefaultRunnerName() ?? "";
    }
    return server.runner;
  }

  private async fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
    const authData = await getAuthData().catch(() => null);
    const token =
      authData?.idToken?.trim() ??
      getBrowserAdapter().simpleAuth?.idToken?.trim() ??
      "";
    const headers = new Headers(init?.headers);
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    const response = await fetch(url, {
      ...init,
      credentials: "include",
      headers,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Request failed with ${response.status}`);
    }
    if (response.status === 204 || response.status === 205) {
      return undefined as T;
    }
    const text = await response.text();
    if (!text.trim()) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  private getAliasKey(serverName: string, alias: string): string {
    return `${serverName}:${alias}`;
  }

  async listServers(options?: { runnerName?: string }): Promise<JupyterServerRecord[]> {
    const runnerEndpoint = this.resolveRunnerEndpoint(options?.runnerName);
    const baseURL = runnerEndpointToHttpBase(runnerEndpoint);
    const servers = await this.fetchJSON<JupyterServerRecord[]>(
      `${baseURL}/v1/jupyter/servers`,
    );
    this.serversByName.clear();
    servers.forEach((server) => this.serversByName.set(server.name, server));
    this.bumpVersion();
    return servers;
  }

  async ensureRunnerData(runnerName?: string): Promise<void> {
    const effectiveRunner = runnerName?.trim() || this.resolveDefaultRunnerName();
    if (!effectiveRunner) {
      return;
    }
    const existing = this.ensureRunnerPromises.get(effectiveRunner);
    if (existing) {
      await existing;
      return;
    }
    const promise = (async () => {
      const servers = await this.listServers({ runnerName: effectiveRunner });
      const relevant = servers.filter((server) => server.runner === effectiveRunner);
      await Promise.all(
        relevant.map(async (server) => {
          await this.listKernels(server.name);
        }),
      );
    })().finally(() => {
      this.ensureRunnerPromises.delete(effectiveRunner);
    });
    this.ensureRunnerPromises.set(effectiveRunner, promise);
    await promise;
  }

  private resolveDefaultRunnerName(): string {
    return getRunnersManager().getDefaultRunnerName() ?? "";
  }

  async listKernels(serverName: string): Promise<JupyterKernelModel[]> {
    if (!this.serversByName.has(serverName)) {
      await this.listServers();
    }
    const runnerName = this.getServerRunnerName(serverName);
    const baseURL = runnerEndpointToHttpBase(this.resolveRunnerEndpoint(runnerName));
    const kernels = await this.fetchJSON<JupyterKernelModel[]>(
      `${baseURL}/v1/jupyter/servers/${encodePathSegment(serverName)}/kernels`,
    );
    const existingLabels = new Map<string, string>();
    (this.kernelsByServer.get(serverName) ?? []).forEach((entry) => {
      existingLabels.set(entry.model.id, entry.label);
    });
    const next = kernels.map((model) => {
      const aliasLabel =
        existingLabels.get(model.id) ??
        this.kernelAliases.get(this.getAliasKey(serverName, model.name));
      const label = aliasLabel && aliasLabel.trim() ? aliasLabel : model.name || model.id;
      return { model, label };
    });
    this.kernelsByServer.set(serverName, next);
    this.bumpVersion();
    return kernels;
  }

  async startKernel(
    serverName: string,
    options?: { kernelSpec?: string; name?: string; path?: string },
  ): Promise<JupyterKernelModel> {
    if (!this.serversByName.has(serverName)) {
      await this.listServers();
    }
    const runnerName = this.getServerRunnerName(serverName);
    const baseURL = runnerEndpointToHttpBase(this.resolveRunnerEndpoint(runnerName));
    const payload: Record<string, unknown> = {};
    if (options?.kernelSpec?.trim()) {
      payload.name = options.kernelSpec.trim();
    }
    if (options?.path?.trim()) {
      payload.path = options.path.trim();
    }

    const kernel = await this.fetchJSON<JupyterKernelModel>(
      `${baseURL}/v1/jupyter/servers/${encodePathSegment(serverName)}/kernels`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    const alias = options?.name?.trim();
    const label = alias || kernel.name || kernel.id;
    if (alias) {
      this.kernelAliases.set(this.getAliasKey(serverName, alias), kernel.id);
    }
    const existing = this.kernelsByServer.get(serverName) ?? [];
    const filtered = existing.filter((entry) => entry.model.id !== kernel.id);
    filtered.push({
      model: kernel,
      label,
    });
    this.kernelsByServer.set(serverName, filtered);
    this.bumpVersion();
    return kernel;
  }

  async stopKernel(serverName: string, kernelNameOrId: string): Promise<void> {
    const kernelID = await this.resolveKernelID(serverName, kernelNameOrId);
    if (!kernelID) {
      throw new Error(`Kernel ${kernelNameOrId} was not found.`);
    }
    const runnerName = this.getServerRunnerName(serverName);
    const baseURL = runnerEndpointToHttpBase(this.resolveRunnerEndpoint(runnerName));
    await this.fetchJSON<unknown>(
      `${baseURL}/v1/jupyter/servers/${encodePathSegment(serverName)}/kernels/${encodePathSegment(kernelID)}`,
      {
        method: "DELETE",
      },
    );
    const existing = this.kernelsByServer.get(serverName) ?? [];
    this.kernelsByServer.set(
      serverName,
      existing.filter((entry) => entry.model.id !== kernelID),
    );
    for (const [key, value] of this.kernelAliases.entries()) {
      if (key.startsWith(`${serverName}:`) && value === kernelID) {
        this.kernelAliases.delete(key);
      }
    }
    this.bumpVersion();
  }

  async resolveKernelID(serverName: string, kernelNameOrId: string): Promise<string> {
    const trimmed = kernelNameOrId.trim();
    if (!trimmed) {
      return "";
    }
    const aliasID = this.kernelAliases.get(this.getAliasKey(serverName, trimmed));
    if (aliasID) {
      return aliasID;
    }
    const cached = this.kernelsByServer.get(serverName) ?? [];
    const fromCached =
      cached.find((entry) => entry.model.id === trimmed)?.model.id ??
      cached.find((entry) => entry.label === trimmed)?.model.id ??
      cached.find((entry) => entry.model.name === trimmed)?.model.id;
    if (fromCached) {
      return fromCached;
    }
    await this.listKernels(serverName);
    const refreshed = this.kernelsByServer.get(serverName) ?? [];
    return (
      refreshed.find((entry) => entry.model.id === trimmed)?.model.id ??
      refreshed.find((entry) => entry.label === trimmed)?.model.id ??
      refreshed.find((entry) => entry.model.name === trimmed)?.model.id ??
      ""
    );
  }

  getKernelOptionsForRunner(runnerName: string): JupyterKernelOption[] {
    const resolvedRunner =
      runnerName === DEFAULT_RUNNER_PLACEHOLDER
        ? this.resolveDefaultRunnerName()
        : runnerName;
    const options: JupyterKernelOption[] = [];
    for (const [serverName, server] of this.serversByName.entries()) {
      if (server.runner !== resolvedRunner) {
        continue;
      }
      const kernels = this.kernelsByServer.get(serverName) ?? [];
      kernels.forEach((entry) => {
        const kernelID = entry.model.id;
        const label = entry.label || entry.model.name || kernelID;
        options.push({
          key: `${encodePathSegment(serverName)}:${encodePathSegment(kernelID)}`,
          label,
          serverName,
          kernelId: kernelID,
          kernelName: entry.model.name || label,
        });
      });
    }
    options.sort((a, b) => a.label.localeCompare(b.label));
    return options;
  }

  parseKernelOptionKey(
    key: string,
  ): { serverName: string; kernelId: string } | null {
    if (!key || !key.includes(":")) {
      return null;
    }
    const [serverEncoded, kernelEncoded] = key.split(":", 2);
    if (!serverEncoded || !kernelEncoded) {
      return null;
    }
    return {
      serverName: decodePathSegment(serverEncoded),
      kernelId: decodePathSegment(kernelEncoded),
    };
  }

  getKernelOptionKey(serverName: string, kernelId: string): string {
    return `${encodePathSegment(serverName)}:${encodePathSegment(kernelId)}`;
  }
}

export function getJupyterManager(): JupyterManager {
  return JupyterManager.getInstance();
}
