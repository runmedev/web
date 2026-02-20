import { useSyncExternalStore } from "react";

import { DEFAULT_RUNME_SERVER_BASE_URL } from "./aisreClient";
import { appLogger } from "./logging/runtime";

// Kept in sync with SettingsContext/appConfig localStorage shape for compatibility.
const SETTINGS_STORAGE_KEY = "cloudAssistantSettings";

export type AgentEndpointSnapshot = {
  endpoint: string;
  defaultEndpoint: string;
  hasOverride: boolean;
};

type Listener = () => void;

type StoredSettings = {
  agentEndpoint?: string;
  [key: string]: unknown;
};

export class AgentEndpointManager {
  private static singleton: AgentEndpointManager | null = null;

  private listeners = new Set<Listener>();

  private loaded = false;

  private overrideEndpoint: string | null = null;

  private defaultEndpoint: string | null = null;

  static instance(): AgentEndpointManager {
    if (!this.singleton) {
      this.singleton = new AgentEndpointManager();
    }
    return this.singleton;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): AgentEndpointSnapshot {
    this.ensureLoaded();
    const defaultEndpoint = this.getDefault();
    return {
      endpoint: this.overrideEndpoint ?? defaultEndpoint,
      defaultEndpoint,
      hasOverride: this.overrideEndpoint !== null,
    };
  }

  get(): string {
    return this.getSnapshot().endpoint;
  }

  getDefault(): string {
    this.ensureLoaded();
    if (this.defaultEndpoint) {
      return this.defaultEndpoint;
    }
    const fallback = this.resolveFallbackDefault();
    this.defaultEndpoint = fallback;
    return fallback;
  }

  hasOverride(): boolean {
    this.ensureLoaded();
    return this.overrideEndpoint !== null;
  }

  set(endpoint: string): string {
    this.ensureLoaded();
    const normalized = this.normalize(endpoint);
    if (!normalized) {
      throw new Error("Agent endpoint must be a non-empty string");
    }
    if (this.overrideEndpoint === normalized) {
      return normalized;
    }
    this.overrideEndpoint = normalized;
    this.persistOverride(normalized);
    this.emit();
    return normalized;
  }

  reset(): string {
    this.ensureLoaded();
    if (this.overrideEndpoint === null) {
      return this.get();
    }
    this.overrideEndpoint = null;
    this.persistOverride(null);
    this.emit();
    return this.get();
  }

  setDefaultEndpoint(endpoint?: string | null): string {
    this.ensureLoaded();
    const nextDefault = this.normalize(endpoint) ?? this.resolveFallbackDefault();
    const prevSnapshot = this.getSnapshot();
    this.defaultEndpoint = nextDefault;
    const nextSnapshot = this.getSnapshot();
    if (
      prevSnapshot.defaultEndpoint !== nextSnapshot.defaultEndpoint ||
      prevSnapshot.endpoint !== nextSnapshot.endpoint
    ) {
      this.emit();
    }
    return nextDefault;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    this.defaultEndpoint = this.resolveFallbackDefault();
    this.overrideEndpoint = this.readOverrideFromStorage();
  }

  private normalize(value?: string | null): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed.replace(/\/+$/, "");
  }

  private resolveFallbackDefault(): string {
    if (typeof window === "undefined") {
      return DEFAULT_RUNME_SERVER_BASE_URL;
    }
    const origin = this.normalize(window.location?.origin);
    return origin ?? DEFAULT_RUNME_SERVER_BASE_URL;
  }

  private readSettingsFromStorage(): StoredSettings {
    if (typeof window === "undefined" || !window.localStorage) {
      return {};
    }
    try {
      const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) {
        return {};
      }
      return (JSON.parse(raw) as StoredSettings | null) ?? {};
    } catch (error) {
      appLogger.warn("Failed to parse cloudAssistantSettings while loading agent endpoint.", {
        attrs: {
          scope: "config.agent",
          code: "AGENT_ENDPOINT_SETTINGS_PARSE_FAILED",
          error: String(error),
        },
      });
      return {};
    }
  }

  private writeSettingsToStorage(settings: StoredSettings): void {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    try {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
      appLogger.warn("Failed to persist agent endpoint to cloudAssistantSettings.", {
        attrs: {
          scope: "config.agent",
          code: "AGENT_ENDPOINT_SETTINGS_PERSIST_FAILED",
          error: String(error),
        },
      });
    }
  }

  private readOverrideFromStorage(): string | null {
    const settings = this.readSettingsFromStorage();
    return this.normalize(settings.agentEndpoint);
  }

  private persistOverride(endpoint: string | null): void {
    const settings = this.readSettingsFromStorage();
    if (endpoint) {
      settings.agentEndpoint = endpoint;
    } else {
      delete settings.agentEndpoint;
    }
    this.writeSettingsToStorage(settings);
  }
}

export const agentEndpointManager = AgentEndpointManager.instance();

export function useAgentEndpointSnapshot(): AgentEndpointSnapshot {
  return useSyncExternalStore(
    (listener) => agentEndpointManager.subscribe(listener),
    () => agentEndpointManager.getSnapshot(),
    () => ({
      endpoint: DEFAULT_RUNME_SERVER_BASE_URL,
      defaultEndpoint: DEFAULT_RUNME_SERVER_BASE_URL,
      hasOverride: false,
    }),
  );
}
