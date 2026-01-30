import { googleClientManager } from "../lib/googleClientManager";

export type OidcConfig = {
  discoveryUrl: string;
  clientId: string;
  clientSecret?: string;
  scope: string;
  redirectUri: string;
  extraAuthParams?: Record<string, string>;
};

type StoredOidcConfig = {
  discoveryUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  redirectUri?: string;
  extraAuthParams?: Record<string, string>;
};

const STORAGE_KEY = "oidcConfig";

function env(name: string): string | undefined {
  const value = import.meta.env[name as keyof ImportMetaEnv];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sanitizeString(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export class OidcConfigManager {
  private static singleton: OidcConfigManager | null = null;
  private config: OidcConfig;

  private constructor() {
    const envConfig = this.readEnvConfig();
    const stored = this.readConfigFromStorage();
    this.config = this.mergeConfig(envConfig, stored);
  }

  static instance(): OidcConfigManager {
    if (!this.singleton) {
      this.singleton = new OidcConfigManager();
    }
    return this.singleton;
  }

  getConfig(): OidcConfig {
    this.assertRequired(this.config);
    return this.config;
  }

  getRedirectURI(): string {
    this.assertRequired(this.config);
    return this.config.redirectUri;
  }

  getScope(): string {
    this.assertRequired(this.config);
    return this.config.scope;
  }

  setConfig(config: Partial<OidcConfig>): OidcConfig {
    const extraAuthParams = config.extraAuthParams
      ? this.sanitizeExtraAuthParams(config.extraAuthParams)
      : undefined;
    const normalizedExtraAuthParams =
      extraAuthParams && Object.keys(extraAuthParams).length > 0
        ? extraAuthParams
        : undefined;
    this.config = {
      ...this.config,
      ...config,
      extraAuthParams: normalizedExtraAuthParams ?? this.config.extraAuthParams,
    };
    this.persistConfig(this.config);
    this.assertRequired(this.config);
    return this.config;
  }

  setClientId(clientId: string): OidcConfig {
    return this.setConfig({ clientId });
  }

  setClientSecret(clientSecret: string): OidcConfig {
    return this.setConfig({ clientSecret });
  }

  setDiscoveryURL(discoveryUrl: string): OidcConfig {
    return this.setConfig({ discoveryUrl });
  }

  setClientToDrive(): OidcConfig {
    const { clientId, clientSecret } = googleClientManager.getOAuthClient();
    return this.setConfig({ clientId, clientSecret });
  }

  setScope(scope: string): OidcConfig {
    return this.setConfig({ scope });
  }

  setGoogleDefaults(): OidcConfig {
    return this.setConfig({
      discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
      scope: "openid https://www.googleapis.com/auth/userinfo.email",
    });
  }

  private readEnvConfig(): OidcConfig {
    const discoveryUrl =
      env("VITE_OIDC_DISCOVERY_URL") ??
      env("VITE_AUTHAPI_DISCOVERY_URL") ??
      "";
    const clientId =
      env("VITE_OIDC_CLIENT_ID") ?? env("VITE_OAUTH_CLIENT_ID") ?? "";
    const clientSecret =
      env("VITE_OIDC_CLIENT_SECRET") ?? env("VITE_OAUTH_CLIENT_SECRET");
    const scope = env("VITE_OIDC_SCOPE") ?? env("VITE_OAUTH_SCOPE") ?? "";
    const redirectUri =
      env("VITE_OIDC_REDIRECT_URI") ??
      new URL("/oidc/callback", window.location.origin).toString();

    const extraAuthParams: Record<string, string> = {};
    const prompt = env("VITE_OIDC_PROMPT");
    if (prompt) {
      extraAuthParams.prompt = prompt;
    }
    const audience = env("VITE_OIDC_AUDIENCE");
    if (audience) {
      extraAuthParams.audience = audience;
    }

    return {
      discoveryUrl,
      clientId,
      clientSecret: clientSecret?.trim() || undefined,
      scope,
      redirectUri,
      extraAuthParams: Object.keys(extraAuthParams).length
        ? extraAuthParams
        : undefined,
    };
  }

  private mergeConfig(envConfig: OidcConfig, stored?: StoredOidcConfig): OidcConfig {
    const storedExtra =
      stored?.extraAuthParams && Object.keys(stored.extraAuthParams).length > 0
        ? this.sanitizeExtraAuthParams(stored.extraAuthParams)
        : undefined;
    const mergedExtra =
      storedExtra || envConfig.extraAuthParams
        ? { ...envConfig.extraAuthParams, ...storedExtra }
        : undefined;
    const merged: OidcConfig = {
      discoveryUrl: sanitizeString(stored?.discoveryUrl) ?? envConfig.discoveryUrl,
      clientId: sanitizeString(stored?.clientId) ?? envConfig.clientId,
      clientSecret:
        sanitizeString(stored?.clientSecret) ?? envConfig.clientSecret,
      scope: sanitizeString(stored?.scope) ?? envConfig.scope,
      redirectUri: sanitizeString(stored?.redirectUri) ?? envConfig.redirectUri,
      extraAuthParams:
        mergedExtra && Object.keys(mergedExtra).length > 0
          ? mergedExtra
          : undefined,
    };

    return merged;
  }

  private sanitizeExtraAuthParams(
    params: Record<string, string>,
  ): Record<string, string> {
    return Object.entries(params).reduce<Record<string, string>>(
      (acc, [key, value]) => {
        const sanitizedKey = key.trim();
        const sanitizedValue = value.trim();
        if (sanitizedKey.length > 0 && sanitizedValue.length > 0) {
          acc[sanitizedKey] = sanitizedValue;
        }
        return acc;
      },
      {},
    );
  }

  private readConfigFromStorage(): StoredOidcConfig | null {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as StoredOidcConfig | null;
      return parsed ?? null;
    } catch (error) {
      console.warn("Failed to read OIDC config from storage", error);
      return null;
    }
  }

  private persistConfig(config: OidcConfig): void {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          discoveryUrl: config.discoveryUrl,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          scope: config.scope,
          redirectUri: config.redirectUri,
          extraAuthParams: config.extraAuthParams,
        }),
      );
    } catch (error) {
      console.warn("Failed to persist OIDC config", error);
    }
  }

  private assertRequired(config: OidcConfig): void {
    if (!config.discoveryUrl) {
      throw new Error("Missing VITE_OIDC_DISCOVERY_URL");
    }
    if (!config.clientId) {
      throw new Error("Missing VITE_OIDC_CLIENT_ID");
    }
    if (!config.scope) {
      throw new Error("Missing VITE_OIDC_SCOPE");
    }
  }
}

export const oidcConfigManager = OidcConfigManager.instance();

export function getOidcConfig(): OidcConfig {
  return oidcConfigManager.getConfig();
}
