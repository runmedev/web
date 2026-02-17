import {
  AisreClient,
  DEFAULT_RUNME_SERVER_BASE_URL,
  type AisreClientOptions,
  createAisreClient,
} from "./aisreClient";
import { getAuthData } from "../token";

// Storage key aligns with SettingsContext to avoid duplicating state elsewhere.
const SETTINGS_STORAGE_KEY = "cloudAssistantSettings";

/**
 * AisreClientManager owns a globally accessible AisreClient instance so
 * non-React code can fetch a configured client without wiring contexts.
 */
export class AisreClientManager {
  private static singleton: AisreClientManager | null = null;
  private currentDefault: AisreClient | null = null;

  static instance(): AisreClientManager {
    if (!this.singleton) {
      this.singleton = new AisreClientManager();
    }
    return this.singleton;
  }

  /**
   * Return the current default client, lazily creating one using the persisted
   * agent endpoint or falling back to the app origin.
   */
  get(): AisreClient {
    if (this.currentDefault) {
      return this.currentDefault;
    }

    const storedEndpoint = this.readAgentEndpointFromStorage();
    if (storedEndpoint) {
      return this.setDefault({ baseUrl: storedEndpoint });
    }

    return this.setDefault({ baseUrl: this.resolveAppOrigin() });
  }

  /**
   * Create and register a new default client using the provided options.
   */
  setDefault(options?: AisreClientOptions): AisreClient {
    const client = createAisreClient({
      getIdToken: async () => (await getAuthData())?.idToken,
      ...options,
    });
    this.currentDefault = client;
    return client;
  }

  private readAgentEndpointFromStorage(): string | null {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
    try {
      const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as { agentEndpoint?: string } | null;
      const endpoint = parsed?.agentEndpoint?.trim();
      return endpoint && endpoint.length > 0 ? endpoint : null;
    } catch (error) {
      console.warn("Failed to read agent endpoint from localStorage", error);
      return null;
    }
  }

  private resolveAppOrigin(): string {
    if (typeof window === "undefined") {
      return DEFAULT_RUNME_SERVER_BASE_URL;
    }
    const origin = window.location?.origin?.trim();
    return origin && origin.length > 0
      ? origin.replace(/\/+$/, "")
      : DEFAULT_RUNME_SERVER_BASE_URL;
  }
}

export const aisreClientManager = AisreClientManager.instance();
