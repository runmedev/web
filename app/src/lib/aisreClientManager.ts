import {
  AisreClient,
  type AisreClientOptions,
  createAisreClient,
} from "./aisreClient";
import { agentEndpointManager } from "./agentEndpointManager";
import { getAuthData } from "../token";

/**
 * AisreClientManager owns a globally accessible AisreClient instance so
 * non-React code can fetch a configured client without wiring contexts.
 */
export class AisreClientManager {
  private static singleton: AisreClientManager | null = null;
  private currentDefault: AisreClient | null = null;

  private constructor() {
    agentEndpointManager.subscribe(() => {
      this.currentDefault = null;
    });
  }

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

    return this.setDefault({ baseUrl: agentEndpointManager.get() });
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
}

export const aisreClientManager = AisreClientManager.instance();
