import { useSyncExternalStore } from "react";

import { appLogger } from "../logging/runtime";

export type ResponsesDirectAuthMethod = "oauth" | "api_key";

export type ResponsesDirectConfigSnapshot = {
  authMethod: ResponsesDirectAuthMethod;
  openaiOrganization: string;
  openaiProject: string;
  vectorStores: string[];
  apiKey: string;
};

export type ResponsesDirectConfigDefaults = {
  authMethod?: string;
  openaiOrganization?: string;
  openaiProject?: string;
  vectorStores?: string[];
};

type Listener = () => void;

type StoredResponsesDirectConfig = Partial<ResponsesDirectConfigSnapshot>;

const STORAGE_KEY = "runme/responses-direct-config";
const DEFAULT_AUTH_METHOD: ResponsesDirectAuthMethod = "oauth";

function normalizeString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeString(entry))
    .filter((entry): entry is string => entry.length > 0);
}

function normalizeAuthMethod(value: unknown): ResponsesDirectAuthMethod {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === "api_key" || normalized === "apikey" || normalized === "api-key") {
    return "api_key";
  }
  return "oauth";
}

function defaultSnapshot(): ResponsesDirectConfigSnapshot {
  return {
    authMethod: DEFAULT_AUTH_METHOD,
    openaiOrganization: "",
    openaiProject: "",
    vectorStores: [],
    apiKey: "",
  };
}

export class ResponsesDirectConfigManager {
  private static singleton: ResponsesDirectConfigManager | null = null;

  private listeners = new Set<Listener>();

  private loaded = false;

  private storageInitialized = false;

  private snapshot = defaultSnapshot();

  static instance(): ResponsesDirectConfigManager {
    if (!this.singleton) {
      this.singleton = new ResponsesDirectConfigManager();
    }
    return this.singleton;
  }

  static resetForTests(): void {
    this.singleton = null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): ResponsesDirectConfigSnapshot {
    this.ensureLoaded();
    return this.snapshot;
  }

  hasInitializedConfig(): boolean {
    this.ensureLoaded();
    return this.storageInitialized;
  }

  setAuthMethod(authMethod: string): ResponsesDirectConfigSnapshot {
    this.ensureLoaded();
    return this.setPartial({
      authMethod: normalizeAuthMethod(authMethod),
    });
  }

  setOpenAIOrganization(openaiOrganization: string): ResponsesDirectConfigSnapshot {
    this.ensureLoaded();
    return this.setPartial({
      openaiOrganization: normalizeString(openaiOrganization),
    });
  }

  setOpenAIProject(openaiProject: string): ResponsesDirectConfigSnapshot {
    this.ensureLoaded();
    return this.setPartial({
      openaiProject: normalizeString(openaiProject),
    });
  }

  setVectorStores(vectorStores: string[]): ResponsesDirectConfigSnapshot {
    this.ensureLoaded();
    return this.setPartial({
      vectorStores: normalizeStringArray(vectorStores),
    });
  }

  setAPIKey(apiKey: string): ResponsesDirectConfigSnapshot {
    this.ensureLoaded();
    return this.setPartial({
      apiKey: normalizeString(apiKey),
    });
  }

  clearAPIKey(): ResponsesDirectConfigSnapshot {
    this.ensureLoaded();
    return this.setPartial({ apiKey: "" });
  }

  applyDefaults(defaults: ResponsesDirectConfigDefaults): ResponsesDirectConfigSnapshot {
    this.ensureLoaded();

    if (this.storageInitialized) {
      const next: Partial<ResponsesDirectConfigSnapshot> = {};
      if (!this.snapshot.openaiOrganization && normalizeString(defaults.openaiOrganization)) {
        next.openaiOrganization = normalizeString(defaults.openaiOrganization);
      }
      if (!this.snapshot.openaiProject && normalizeString(defaults.openaiProject)) {
        next.openaiProject = normalizeString(defaults.openaiProject);
      }
      if (
        this.snapshot.vectorStores.length === 0 &&
        Array.isArray(defaults.vectorStores) &&
        defaults.vectorStores.length > 0
      ) {
        next.vectorStores = normalizeStringArray(defaults.vectorStores);
      }
      if (
        this.snapshot.authMethod === DEFAULT_AUTH_METHOD &&
        normalizeString(defaults.authMethod) &&
        normalizeAuthMethod(defaults.authMethod) !== DEFAULT_AUTH_METHOD
      ) {
        next.authMethod = normalizeAuthMethod(defaults.authMethod);
      }
      if (Object.keys(next).length === 0) {
        return this.snapshot;
      }
      return this.setPartial(next);
    }

    const seeded: ResponsesDirectConfigSnapshot = {
      authMethod: normalizeAuthMethod(defaults.authMethod),
      openaiOrganization: normalizeString(defaults.openaiOrganization),
      openaiProject: normalizeString(defaults.openaiProject),
      vectorStores: normalizeStringArray(defaults.vectorStores),
      apiKey: "",
    };
    this.snapshot = seeded;
    this.storageInitialized = true;
    this.persist();
    this.emit();
    return this.snapshot;
  }

  private setPartial(patch: Partial<ResponsesDirectConfigSnapshot>): ResponsesDirectConfigSnapshot {
    const next: ResponsesDirectConfigSnapshot = {
      ...this.snapshot,
      ...patch,
      authMethod: normalizeAuthMethod(patch.authMethod ?? this.snapshot.authMethod),
      openaiOrganization: normalizeString(
        patch.openaiOrganization ?? this.snapshot.openaiOrganization,
      ),
      openaiProject: normalizeString(patch.openaiProject ?? this.snapshot.openaiProject),
      vectorStores: normalizeStringArray(patch.vectorStores ?? this.snapshot.vectorStores),
      apiKey: normalizeString(patch.apiKey ?? this.snapshot.apiKey),
    };
    const changed = JSON.stringify(next) !== JSON.stringify(this.snapshot);
    this.snapshot = next;
    this.storageInitialized = true;
    this.persist();
    if (changed) {
      this.emit();
    }
    return this.snapshot;
  }

  private ensureLoaded(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as StoredResponsesDirectConfig | null;
      if (!parsed || typeof parsed !== "object") {
        return;
      }
      this.snapshot = {
        authMethod: normalizeAuthMethod(parsed.authMethod),
        openaiOrganization: normalizeString(parsed.openaiOrganization),
        openaiProject: normalizeString(parsed.openaiProject),
        vectorStores: normalizeStringArray(parsed.vectorStores),
        apiKey: normalizeString(parsed.apiKey),
      };
      this.storageInitialized = true;
    } catch (error) {
      appLogger.warn("Failed to load responses-direct config from storage", {
        attrs: {
          scope: "chatkit.responses_direct_config",
          error: String(error),
        },
      });
    }
  }

  private persist(): void {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.snapshot));
    } catch (error) {
      appLogger.warn("Failed to persist responses-direct config to storage", {
        attrs: {
          scope: "chatkit.responses_direct_config",
          error: String(error),
        },
      });
    }
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

export const responsesDirectConfigManager = ResponsesDirectConfigManager.instance();

export function useResponsesDirectConfigSnapshot(): ResponsesDirectConfigSnapshot {
  return useSyncExternalStore(
    (listener) => responsesDirectConfigManager.subscribe(listener),
    () => responsesDirectConfigManager.getSnapshot(),
    () => defaultSnapshot(),
  );
}

export function __resetResponsesDirectConfigManagerForTests(): void {
  ResponsesDirectConfigManager.resetForTests();
}
