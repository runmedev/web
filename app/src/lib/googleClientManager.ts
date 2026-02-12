export type GoogleOAuthClientConfig = {
  clientId: string;
  clientSecret?: string;
};

export type GoogleDrivePickerConfig = {
  clientId: string;
  developerKey: string;
  appId: string;
};

export const GOOGLE_CLIENT_STORAGE_KEY = "googleClientConfig";
const STORAGE_KEY = GOOGLE_CLIENT_STORAGE_KEY;

type GoogleClientConfig = {
  oauth: GoogleOAuthClientConfig;
  drivePicker: GoogleDrivePickerConfig;
};

export class GoogleClientManager {
  private static singleton: GoogleClientManager | null = null;
  private config: GoogleClientConfig;

  private constructor() {
    const defaultClientId ="";
    const storedClientId = this.readOAuthClientIdFromStorage();
    const injectedClientId =
      storedClientId ? null : this.readOAuthClientIdFromInitialState();
    const storedClientSecret = this.readOAuthClientSecretFromStorage();
    const injectedClientSecret = storedClientSecret
      ? null
      : this.readOAuthClientSecretFromInitialState();
    const resolvedClientId =
      storedClientId ?? injectedClientId ?? defaultClientId;
    const resolvedClientSecret =
      storedClientSecret ?? injectedClientSecret ?? undefined;
    this.config = {
      oauth: { clientId: resolvedClientId, clientSecret: resolvedClientSecret },
      drivePicker: {
        clientId: resolvedClientId,
        developerKey: "",
        // TODO(jlewi): Do we still need this
        appId: "notavalidappid",
      },
    };
  }

  static instance(): GoogleClientManager {
    if (!this.singleton) {
      this.singleton = new GoogleClientManager();
    }
    return this.singleton;
  }

  getOAuthClient(): GoogleOAuthClientConfig {
    return this.config.oauth;
  }

  setClientId(clientId: string): GoogleOAuthClientConfig {
    return this.setOAuthClient({ clientId });
  }

  setOAuthClient(config: Partial<GoogleOAuthClientConfig>): GoogleOAuthClientConfig {
    this.config.oauth = {
      ...this.config.oauth,
      ...config,
    };
    this.persistOAuthClient(this.config.oauth);
    return this.config.oauth;
  }

  setClientSecret(clientSecret: string): GoogleOAuthClientConfig {
    return this.setOAuthClient({ clientSecret });
  }

  setOAuthClientFromJson(raw: string): GoogleOAuthClientConfig {
    let parsed:
      | { client_id?: string; clientId?: string; client_secret?: string }
      | null = null;
    try {
      parsed = JSON.parse(raw) as {
        client_id?: string;
        clientId?: string;
        client_secret?: string;
      };
    } catch (error) {
      throw new Error("Invalid JSON: unable to parse OAuth client config");
    }

    const clientId = (parsed?.client_id ?? parsed?.clientId ?? "").trim();
    if (!clientId) {
      throw new Error("OAuth client config is missing client_id");
    }
    const clientSecret = parsed?.client_secret?.trim() ?? "";

    return this.setOAuthClient({
      clientId,
      clientSecret: clientSecret.length > 0 ? clientSecret : undefined,
    });
  }

  getDrivePickerConfig(): GoogleDrivePickerConfig {
    return this.config.drivePicker;
  }

  setDrivePickerConfig(
    config: Partial<GoogleDrivePickerConfig>,
  ): GoogleDrivePickerConfig {
    this.config.drivePicker = {
      ...this.config.drivePicker,
      ...config,
    };
    return this.config.drivePicker;
  }

  private readOAuthClientIdFromStorage(): string | null {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as { oauthClientId?: string } | null;
      const clientId = parsed?.oauthClientId?.trim();
      return clientId && clientId.length > 0 ? clientId : null;
    } catch (error) {
      console.warn("Failed to read Google OAuth client config", error);
      return null;
    }
  }

  private readOAuthClientSecretFromStorage(): string | null {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as { oauthClientSecret?: string } | null;
      const clientSecret = parsed?.oauthClientSecret?.trim();
      return clientSecret && clientSecret.length > 0 ? clientSecret : null;
    } catch (error) {
      console.warn("Failed to read Google OAuth client config", error);
      return null;
    }
  }

  private readOAuthClientIdFromInitialState(): string | null {
    if (typeof window === "undefined") {
      return null;
    }
    const state = window.__INITIAL_STATE__ as
      | { google?: { oauthClientId?: string; oauthClientSecret?: string } }
      | undefined;
    const clientId = state?.google?.oauthClientId?.trim();
    return clientId && clientId.length > 0 ? clientId : null;
  }

  private readOAuthClientSecretFromInitialState(): string | null {
    if (typeof window === "undefined") {
      return null;
    }
    const state = window.__INITIAL_STATE__ as
      | { google?: { oauthClientId?: string; oauthClientSecret?: string } }
      | undefined;
    const clientSecret = state?.google?.oauthClientSecret?.trim();
    return clientSecret && clientSecret.length > 0 ? clientSecret : null;
  }

  private persistOAuthClient(config: GoogleOAuthClientConfig): void {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          oauthClientId: config.clientId,
          oauthClientSecret: config.clientSecret,
        }),
      );
    } catch (error) {
      console.warn("Failed to persist Google OAuth client config", error);
    }
  }
}

export const googleClientManager = GoogleClientManager.instance();
