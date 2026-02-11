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

function sanitizeString(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export class OidcConfigManager {
  private static singleton: OidcConfigManager | null = null;
  private config: OidcConfig;

  private constructor() {
    const stored = this.readConfigFromStorage();
    this.config = this.mergeConfig(stored);
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
      extraAuthParams: {
        access_type: "offline",
        prompt: "consent",
      },
    });
  }

  private mergeConfig(stored?: StoredOidcConfig): OidcConfig {
    const storedExtra =
      stored?.extraAuthParams && Object.keys(stored.extraAuthParams).length > 0
        ? this.sanitizeExtraAuthParams(stored.extraAuthParams)
        : undefined;
    const mergedExtra = storedExtra ?? undefined;
    const merged: OidcConfig = {
      discoveryUrl: sanitizeString(stored?.discoveryUrl) ?? "",
      clientId: sanitizeString(stored?.clientId) ?? "",
      clientSecret: sanitizeString(stored?.clientSecret),
      scope: sanitizeString(stored?.scope) ?? "",
      redirectUri:
        sanitizeString(stored?.redirectUri) ??
        new URL("/oidc/callback", window.location.origin).toString(),
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
