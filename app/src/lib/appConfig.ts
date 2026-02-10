import YAML from "yaml";

import type { OidcConfig } from "../auth/oidcConfig";
import { oidcConfigManager } from "../auth/oidcConfig";
import type { GoogleOAuthClientConfig } from "./googleClientManager";
import { googleClientManager } from "./googleClientManager";

type RawOidcGenericConfig = {
  clientID?: string;
  clientId?: string;
  clientSecret?: string;
  redirectURL?: string;
  redirectUrl?: string;
  discoveryURL?: string;
  discoveryUrl?: string;
  scopes?: string[] | string;
  issuer?: string;
};

type RawAppConfig = {
  oidc?: {
    clientExchange?: boolean;
    generic?: RawOidcGenericConfig;
  };
  googleDrive?: {
    clientID?: string;
    clientId?: string;
    clientSecret?: string;
  };
};

export type AppliedAppConfig = {
  url: string;
  oidc?: OidcConfig;
  googleOAuth?: GoogleOAuthClientConfig;
  warnings: string[];
};

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeScope(scopes: unknown): string | undefined {
  if (Array.isArray(scopes)) {
    const normalized = scopes
      .map((scope) => normalizeString(scope))
      .filter((scope): scope is string => Boolean(scope));
    return normalized.length > 0 ? normalized.join(" ") : undefined;
  }
  return normalizeString(scopes);
}

function extractOidcConfig(raw: RawAppConfig): Partial<OidcConfig> {
  const generic = raw.oidc?.generic;
  if (!generic) {
    return {};
  }
  const config: Partial<OidcConfig> = {};
  const discoveryUrl =
    normalizeString(generic.discoveryURL) ??
    normalizeString(generic.discoveryUrl);
  if (discoveryUrl) {
    config.discoveryUrl = discoveryUrl;
  }
  const clientId =
    normalizeString(generic.clientID) ?? normalizeString(generic.clientId);
  if (clientId) {
    config.clientId = clientId;
  }
  const clientSecret = normalizeString(generic.clientSecret);
  if (clientSecret) {
    config.clientSecret = clientSecret;
  }
  const redirectUri =
    normalizeString(generic.redirectURL) ??
    normalizeString(generic.redirectUrl);
  if (redirectUri) {
    config.redirectUri = redirectUri;
  }
  const scope = normalizeScope(generic.scopes);
  if (scope) {
    config.scope = scope;
  }
  return config;
}

function extractGoogleConfig(raw: RawAppConfig): GoogleOAuthClientConfig | null {
  const google = raw.googleDrive;
  if (!google) {
    return null;
  }
  const clientId =
    normalizeString(google.clientID) ?? normalizeString(google.clientId);
  if (!clientId) {
    return null;
  }
  const clientSecret = normalizeString(google.clientSecret);
  return {
    clientId,
    clientSecret,
  };
}

export function getDefaultAppConfigUrl(): string {
  if (typeof window === "undefined") {
    return "/configs/app-configs.yaml";
  }
  return new URL("/configs/app-configs.yaml", window.location.origin).toString();
}

export function applyAppConfig(
  rawConfig: unknown,
  url: string,
): AppliedAppConfig {
  if (!rawConfig || typeof rawConfig !== "object") {
    throw new Error("App config is empty or invalid");
  }
  const raw = rawConfig as RawAppConfig;
  const warnings: string[] = [];
  let oidc: OidcConfig | undefined;
  let googleOAuth: GoogleOAuthClientConfig | undefined;

  const oidcConfig = extractOidcConfig(raw);
  if (Object.keys(oidcConfig).length > 0) {
    if (!oidcConfig.redirectUri && typeof window !== "undefined") {
      oidcConfig.redirectUri = new URL(
        "/oidc/callback",
        window.location.origin,
      ).toString();
    }
    try {
      oidc = oidcConfigManager.setConfig(oidcConfig);
    } catch (error) {
      warnings.push(`OIDC config not applied: ${String(error)}`);
    }
  }

  const googleConfig = extractGoogleConfig(raw);
  if (googleConfig) {
    try {
      googleOAuth = googleClientManager.setOAuthClient(googleConfig);
    } catch (error) {
      warnings.push(`Google OAuth config not applied: ${String(error)}`);
    }
  } else if (raw.googleDrive) {
    warnings.push("Google Drive config missing clientID/clientId");
  }

  return {
    url,
    oidc,
    googleOAuth,
    warnings,
  };
}

export async function setAppConfig(url?: string): Promise<AppliedAppConfig> {
  const resolvedUrl = normalizeString(url) ?? getDefaultAppConfigUrl();
  const response = await fetch(resolvedUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch app config (${response.status} ${response.statusText})`,
    );
  }
  const text = await response.text();
  const parsed = YAML.parse(text) as unknown;
  return applyAppConfig(parsed, resolvedUrl);
}
