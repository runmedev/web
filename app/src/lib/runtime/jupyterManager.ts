import { getRunnersManager, DEFAULT_RUNNER_PLACEHOLDER } from "./runnersManager";
import { getAuthData } from "../../token";
import { getBrowserAdapter } from "../../browserAdapter.client";
import { appLogger } from "../logging/runtime";

const KERNEL_ALIASES_STORAGE_KEY = "runme/jupyterKernelAliases";

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
  runnerName: string;
  serverName: string;
  kernelId: string;
  kernelName: string;
};

type KernelCacheEntry = {
  model: JupyterKernelModel;
  label: string;
};

function normalizeKernelName(value: string): string {
  return value.trim().toLowerCase();
}

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
  private static readonly compositeKeySeparator = "\u001f";

  private version = 0;
  private listeners = new Set<() => void>();
  private serversByKey = new Map<string, JupyterServerRecord>();
  private kernelsByServerKey = new Map<string, KernelCacheEntry[]>();
  private kernelAliases = new Map<string, string>();
  private persistedKernelAliasesByKernel = new Map<string, string>();
  private ensureRunnerPromises = new Map<string, Promise<void>>();

  private constructor() {
    this.loadKernelAliasesFromStorage();
  }

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

  private normalizeRunnerName(runnerName: string): string {
    const mgr = getRunnersManager();
    const normalizedRunnerName = runnerName.trim();
    const effectiveName =
      normalizedRunnerName === DEFAULT_RUNNER_PLACEHOLDER
        ? mgr.getDefaultRunnerName() ?? ""
        : normalizedRunnerName;
    if (!effectiveName) {
      throw new Error("Runner name is required.");
    }
    return effectiveName;
  }

  private resolveRunnerEndpoint(runnerName: string): string {
    const effectiveName = this.normalizeRunnerName(runnerName);
    const mgr = getRunnersManager();
    const runner = effectiveName ? mgr.getWithFallback(effectiveName) : undefined;
    if (!runner?.endpoint) {
      throw new Error(`No runner endpoint configured for ${effectiveName}.`);
    }
    return runner.endpoint;
  }

  private getServerKey(runnerName: string, serverName: string): string {
    return `${runnerName}${JupyterManager.compositeKeySeparator}${serverName}`;
  }

  private isServerKeyForRunner(serverKey: string, runnerName: string): boolean {
    return serverKey.startsWith(`${runnerName}${JupyterManager.compositeKeySeparator}`);
  }

  private getServerNameFromKey(serverKey: string): string {
    const [, serverName = ""] = serverKey.split(JupyterManager.compositeKeySeparator, 2);
    return serverName;
  }

  private getAliasKey(runnerName: string, serverName: string, alias: string): string {
    return `${runnerName}${JupyterManager.compositeKeySeparator}${serverName}${JupyterManager.compositeKeySeparator}${alias}`;
  }

  private getKernelAliasKey(runnerName: string, serverName: string, kernelID: string): string {
    return `${runnerName}${JupyterManager.compositeKeySeparator}${serverName}${JupyterManager.compositeKeySeparator}${kernelID}`;
  }

  private parseKernelAliasKey(
    key: string,
  ): { runnerName: string; serverName: string; kernelId: string } | null {
    const parts = key.split(JupyterManager.compositeKeySeparator);
    if (parts.length !== 3) {
      return null;
    }
    const [runnerName, serverName, kernelId] = parts;
    if (!runnerName || !serverName || !kernelId) {
      return null;
    }
    return { runnerName, serverName, kernelId };
  }

  private loadKernelAliasesFromStorage(): void {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const raw = window.localStorage.getItem(KERNEL_ALIASES_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }
      parsed.forEach((entry) => {
        if (
          entry &&
          typeof entry === "object" &&
          typeof (entry as any).runnerName === "string" &&
          typeof (entry as any).serverName === "string" &&
          typeof (entry as any).kernelId === "string" &&
          typeof (entry as any).alias === "string"
        ) {
          const runnerName = (entry as any).runnerName.trim();
          const serverName = (entry as any).serverName.trim();
          const kernelId = (entry as any).kernelId.trim();
          const alias = (entry as any).alias.trim();
          if (runnerName && serverName && kernelId && alias) {
            this.persistedKernelAliasesByKernel.set(
              this.getKernelAliasKey(runnerName, serverName, kernelId),
              alias,
            );
          }
          return;
        }
        // Backwards compatibility with old storage shape: { key, alias }.
        if (
          entry &&
          typeof entry === "object" &&
          typeof (entry as any).key === "string" &&
          typeof (entry as any).alias === "string"
        ) {
          const key = (entry as any).key.trim();
          const alias = (entry as any).alias.trim();
          if (key && alias) {
            this.persistedKernelAliasesByKernel.set(key, alias);
          }
        }
      });
    } catch (error) {
      console.error("Failed to load Jupyter kernel aliases from storage", error);
    }
  }

  private persistKernelAliasesToStorage(): void {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const serialized = [...this.persistedKernelAliasesByKernel.entries()].map(
        ([key, alias]) => ({
          ...(this.parseKernelAliasKey(key) ?? { key }),
          alias,
        }),
      );
      window.localStorage.setItem(KERNEL_ALIASES_STORAGE_KEY, JSON.stringify(serialized));
    } catch (error) {
      console.error("Failed to persist Jupyter kernel aliases to storage", error);
    }
  }

  private setPersistedKernelAlias(
    runnerName: string,
    serverName: string,
    kernelID: string,
    alias: string,
  ): void {
    const key = this.getKernelAliasKey(runnerName, serverName, kernelID);
    const trimmedAlias = alias.trim();
    if (!trimmedAlias) {
      this.persistedKernelAliasesByKernel.delete(key);
    } else {
      this.persistedKernelAliasesByKernel.set(key, trimmedAlias);
    }
    this.persistKernelAliasesToStorage();
  }

  private getPersistedKernelAlias(
    runnerName: string,
    serverName: string,
    kernelID: string,
  ): string {
    return this.persistedKernelAliasesByKernel.get(
      this.getKernelAliasKey(runnerName, serverName, kernelID),
    ) ?? "";
  }

  private rebuildAliasLookupForServer(
    runnerName: string,
    serverName: string,
    entries: KernelCacheEntry[],
  ): void {
    const prefix = `${runnerName}${JupyterManager.compositeKeySeparator}${serverName}${JupyterManager.compositeKeySeparator}`;
    for (const key of this.kernelAliases.keys()) {
      if (key.startsWith(prefix)) {
        this.kernelAliases.delete(key);
      }
    }
    entries.forEach((entry) => {
      const label = entry.label?.trim() ?? "";
      const modelName = entry.model.name?.trim() ?? "";
      if (!label || normalizeKernelName(label) === normalizeKernelName(modelName)) {
        return;
      }
      this.kernelAliases.set(this.getAliasKey(runnerName, serverName, label), entry.model.id);
    });
  }

  private clearRunnerCache(runnerName: string): void {
    for (const serverKey of this.serversByKey.keys()) {
      if (this.isServerKeyForRunner(serverKey, runnerName)) {
        this.serversByKey.delete(serverKey);
      }
    }
    for (const serverKey of this.kernelsByServerKey.keys()) {
      if (this.isServerKeyForRunner(serverKey, runnerName)) {
        this.kernelsByServerKey.delete(serverKey);
      }
    }
    for (const aliasKey of this.kernelAliases.keys()) {
      if (aliasKey.startsWith(`${runnerName}${JupyterManager.compositeKeySeparator}`)) {
        this.kernelAliases.delete(aliasKey);
      }
    }
  }

  private async fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
    const authData = await getAuthData().catch(() => null);
    const token =
      authData?.idToken?.trim() ??
      getBrowserAdapter().simpleAuth?.idToken?.trim() ??
      "";
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        credentials: "include",
        headers,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appLogger.error("Jupyter request failed before receiving a response", {
        attrs: {
          scope: "jupyter.fetch",
          method,
          url,
          hasAuthToken: Boolean(token),
          error: message,
        },
      });
      throw new Error(`Jupyter request failed (${method} ${url}): ${message}`);
    }
    if (!response.ok) {
      const text = await response.text();
      const bodyPreview = text.slice(0, 400);
      appLogger.error("Jupyter request returned non-success response", {
        attrs: {
          scope: "jupyter.fetch",
          method,
          url,
          status: response.status,
          statusText: response.statusText,
          bodyPreview,
        },
      });
      throw new Error(
        `Jupyter request failed (${method} ${url}) with ${response.status} ${response.statusText}: ${
          bodyPreview || "<empty body>"
        }`,
      );
    }
    if (response.status === 204 || response.status === 205) {
      return undefined as T;
    }
    const text = await response.text();
    if (!text.trim()) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const bodyPreview = text.slice(0, 400);
      appLogger.error("Jupyter response was not valid JSON", {
        attrs: {
          scope: "jupyter.fetch",
          method,
          url,
          error: message,
          bodyPreview,
        },
      });
      throw new Error(
        `Invalid JSON from Jupyter request (${method} ${url}): ${message}. Body: ${bodyPreview}`,
      );
    }
  }

  private resolveDefaultRunnerName(): string {
    return getRunnersManager().getDefaultRunnerName() ?? "";
  }

  async listServers(runnerName: string): Promise<JupyterServerRecord[]> {
    const effectiveRunner = this.normalizeRunnerName(runnerName);
    const runnerEndpoint = this.resolveRunnerEndpoint(effectiveRunner);
    const baseURL = runnerEndpointToHttpBase(runnerEndpoint);
    const serversResponse = await this.fetchJSON<JupyterServerRecord[]>(
      `${baseURL}/v1/jupyter/servers`,
    );
    this.clearRunnerCache(effectiveRunner);
    const servers = serversResponse.map((server) => ({
      ...server,
      runner: effectiveRunner,
    }));
    servers.forEach((server) => {
      this.serversByKey.set(
        this.getServerKey(effectiveRunner, server.name),
        server,
      );
    });
    this.bumpVersion();
    return servers;
  }

  async ensureRunnerData(runnerName: string): Promise<void> {
    const requestedRunner = runnerName.trim();
    const effectiveRunner =
      requestedRunner || this.resolveDefaultRunnerName();
    if (!effectiveRunner) {
      return;
    }
    const existing = this.ensureRunnerPromises.get(effectiveRunner);
    if (existing) {
      await existing;
      return;
    }
    const promise = (async () => {
      const servers = await this.listServers(effectiveRunner);
      await Promise.all(
        servers.map(async (server) => {
          await this.listKernels(effectiveRunner, server.name);
        }),
      );
    })().finally(() => {
      this.ensureRunnerPromises.delete(effectiveRunner);
    });
    this.ensureRunnerPromises.set(effectiveRunner, promise);
    await promise;
  }

  private async ensureServerLoaded(
    runnerName: string,
    serverName: string,
  ): Promise<void> {
    const serverKey = this.getServerKey(runnerName, serverName);
    if (this.serversByKey.has(serverKey)) {
      return;
    }
    await this.listServers(runnerName);
    // Do not fail hard here. The backend registry supports reload-on-miss
    // for server names that may not be present in the current list snapshot.
  }

  async listKernels(runnerName: string, serverName: string): Promise<JupyterKernelModel[]> {
    const effectiveRunner = this.normalizeRunnerName(runnerName);
    await this.ensureServerLoaded(effectiveRunner, serverName);
    const baseURL = runnerEndpointToHttpBase(this.resolveRunnerEndpoint(effectiveRunner));
    const kernels = await this.fetchJSON<JupyterKernelModel[]>(
      `${baseURL}/v1/jupyter/servers/${encodePathSegment(serverName)}/kernels`,
    );
    const serverKey = this.getServerKey(effectiveRunner, serverName);
    const existingLabels = new Map<string, string>();
    (this.kernelsByServerKey.get(serverKey) ?? []).forEach((entry) => {
      existingLabels.set(entry.model.id, entry.label);
    });
    const next = kernels.map((model) => {
      const aliasLabel = existingLabels.get(model.id) ||
        this.getPersistedKernelAlias(effectiveRunner, serverName, model.id);
      const label = aliasLabel && aliasLabel.trim() ? aliasLabel : model.name || model.id;
      return { model, label };
    });
    this.kernelsByServerKey.set(serverKey, next);
    this.rebuildAliasLookupForServer(effectiveRunner, serverName, next);
    this.bumpVersion();
    return kernels;
  }

  async startKernel(
    runnerName: string,
    serverName: string,
    options?: { kernelSpec?: string; name?: string; path?: string },
  ): Promise<JupyterKernelModel> {
    const effectiveRunner = this.normalizeRunnerName(runnerName);
    await this.ensureServerLoaded(effectiveRunner, serverName);
    const baseURL = runnerEndpointToHttpBase(this.resolveRunnerEndpoint(effectiveRunner));
    const alias = options?.name?.trim() ?? "";
    if (alias) {
      const existing = await this.listKernels(effectiveRunner, serverName);
      const requestedKey = normalizeKernelName(alias);
      const duplicate = existing.find((kernel) => {
        if (normalizeKernelName(kernel.name || "") === requestedKey) {
          return true;
        }
        const serverKey = this.getServerKey(effectiveRunner, serverName);
        const cached = this.kernelsByServerKey.get(serverKey) ?? [];
        const cacheHit = cached.find((entry) => entry.model.id === kernel.id);
        return normalizeKernelName(cacheHit?.label || "") === requestedKey;
      });
      if (duplicate) {
        throw new Error(
          `Kernel alias "${alias}" already exists on ${effectiveRunner}/${serverName}.`,
        );
      }
    }

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

    const label = alias || kernel.name || kernel.id;
    if (alias) {
      this.setPersistedKernelAlias(effectiveRunner, serverName, kernel.id, alias);
    } else {
      this.setPersistedKernelAlias(effectiveRunner, serverName, kernel.id, "");
    }
    const serverKey = this.getServerKey(effectiveRunner, serverName);
    const existing = this.kernelsByServerKey.get(serverKey) ?? [];
    const filtered = existing.filter((entry) => entry.model.id !== kernel.id);
    filtered.push({
      model: kernel,
      label,
    });
    this.kernelsByServerKey.set(serverKey, filtered);
    this.rebuildAliasLookupForServer(effectiveRunner, serverName, filtered);
    this.bumpVersion();
    return kernel;
  }

  async stopKernel(runnerName: string, serverName: string, kernelNameOrId: string): Promise<void> {
    const effectiveRunner = this.normalizeRunnerName(runnerName);
    const kernelID = await this.resolveKernelID(effectiveRunner, serverName, kernelNameOrId);
    if (!kernelID) {
      throw new Error(`Kernel ${kernelNameOrId} was not found.`);
    }
    const baseURL = runnerEndpointToHttpBase(this.resolveRunnerEndpoint(effectiveRunner));
    await this.fetchJSON<unknown>(
      `${baseURL}/v1/jupyter/servers/${encodePathSegment(serverName)}/kernels/${encodePathSegment(kernelID)}`,
      {
        method: "DELETE",
      },
    );
    const serverKey = this.getServerKey(effectiveRunner, serverName);
    const existing = this.kernelsByServerKey.get(serverKey) ?? [];
    const remaining = existing.filter((entry) => entry.model.id !== kernelID);
    this.kernelsByServerKey.set(serverKey, remaining);
    this.setPersistedKernelAlias(effectiveRunner, serverName, kernelID, "");
    this.rebuildAliasLookupForServer(effectiveRunner, serverName, remaining);
    this.bumpVersion();
  }

  async resolveKernelID(
    runnerName: string,
    serverName: string,
    kernelNameOrId: string,
  ): Promise<string> {
    const effectiveRunner = this.normalizeRunnerName(runnerName);
    const trimmed = kernelNameOrId.trim();
    if (!trimmed) {
      return "";
    }
    const aliasID = this.kernelAliases.get(this.getAliasKey(effectiveRunner, serverName, trimmed));
    if (aliasID) {
      return aliasID;
    }
    const serverKey = this.getServerKey(effectiveRunner, serverName);
    const cached = this.kernelsByServerKey.get(serverKey) ?? [];
    const fromCached =
      cached.find((entry) => entry.model.id === trimmed)?.model.id ??
      cached.find((entry) => entry.label === trimmed)?.model.id ??
      cached.find((entry) => entry.model.name === trimmed)?.model.id;
    if (fromCached) {
      return fromCached;
    }
    await this.listKernels(effectiveRunner, serverName);
    const refreshed = this.kernelsByServerKey.get(serverKey) ?? [];
    return (
      refreshed.find((entry) => entry.model.id === trimmed)?.model.id ??
      refreshed.find((entry) => entry.label === trimmed)?.model.id ??
      refreshed.find((entry) => entry.model.name === trimmed)?.model.id ??
      ""
    );
  }

  getKernelOptionsForRunner(runnerName: string): JupyterKernelOption[] {
    const resolvedRunner = this.normalizeRunnerName(runnerName);
    const options: JupyterKernelOption[] = [];
    for (const [serverKey] of this.serversByKey.entries()) {
      if (!this.isServerKeyForRunner(serverKey, resolvedRunner)) {
        continue;
      }
      const serverName = this.getServerNameFromKey(serverKey);
      const kernels = this.kernelsByServerKey.get(serverKey) ?? [];
      kernels.forEach((entry) => {
        const kernelID = entry.model.id;
        const label = entry.label || entry.model.name || kernelID;
        options.push({
          key: this.getKernelOptionKey(serverName, kernelID, resolvedRunner),
          label,
          runnerName: resolvedRunner,
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
  ): { runnerName?: string; serverName: string; kernelId: string } | null {
    if (!key || !key.includes(":")) {
      return null;
    }
    const parts = key.split(":");
    if (parts.length === 2) {
      const [serverEncoded, kernelEncoded] = parts;
      if (!serverEncoded || !kernelEncoded) {
        return null;
      }
      return {
        serverName: decodePathSegment(serverEncoded),
        kernelId: decodePathSegment(kernelEncoded),
      };
    }
    if (parts.length === 3) {
      const [runnerEncoded, serverEncoded, kernelEncoded] = parts;
      if (!runnerEncoded || !serverEncoded || !kernelEncoded) {
        return null;
      }
      return {
        runnerName: decodePathSegment(runnerEncoded),
        serverName: decodePathSegment(serverEncoded),
        kernelId: decodePathSegment(kernelEncoded),
      };
    }
    return null;
  }

  getKernelOptionKey(serverName: string, kernelId: string, runnerName?: string): string {
    if (runnerName && runnerName.trim()) {
      return `${encodePathSegment(runnerName)}:${encodePathSegment(serverName)}:${encodePathSegment(kernelId)}`;
    }
    return `${encodePathSegment(serverName)}:${encodePathSegment(kernelId)}`;
  }
}

export function getJupyterManager(): JupyterManager {
  return JupyterManager.getInstance();
}
