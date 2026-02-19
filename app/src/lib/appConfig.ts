import YAML from "yaml";

import type { OidcConfig } from "../auth/oidcConfig";
import { OIDC_STORAGE_KEY, oidcConfigManager } from "../auth/oidcConfig";
import {
  APP_CONFIG_PATH_DEFAULT,
  RuntimeAppConfigSchema,
} from "../config/appConfig";
import type { GoogleOAuthClientConfig } from "./googleClientManager";
import {
  GOOGLE_CLIENT_STORAGE_KEY,
  googleClientManager,
} from "./googleClientManager";

const SETTINGS_STORAGE_KEY = "cloudAssistantSettings";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function getDefaultAppConfigUrl(): string {
  if (typeof window === "undefined") {
    return APP_CONFIG_PATH_DEFAULT;
  }
  return new URL(APP_CONFIG_PATH_DEFAULT, window.location.origin).toString();
}

export function applyAppConfig(
  rawConfig: unknown,
  url: string,
): AppliedAppConfig {
  if (!isRecord(rawConfig)) {
    throw new Error("App config is empty or invalid");
  }
  const parsed = RuntimeAppConfigSchema.fromUnknown(rawConfig);
  const hasOidcBlock = isRecord(rawConfig.oidc);
  const hasGoogleDriveBlock = isRecord(rawConfig.googleDrive);
  const warnings: string[] = [];
  let oidc: OidcConfig | undefined;
  let googleOAuth: GoogleOAuthClientConfig | undefined;

  const oidcConfig: Partial<OidcConfig> = {};
  const genericOidcConfig = parsed.oidc.generic;
  const oidcScope =
    genericOidcConfig.scopes.length > 0
      ? genericOidcConfig.scopes.join(" ")
      : undefined;
  const discoveryUrl = normalizeString(genericOidcConfig.discoveryUrl);
  const clientId = normalizeString(genericOidcConfig.clientId);
  const clientSecret = normalizeString(genericOidcConfig.clientSecret);
  const redirectUri = normalizeString(genericOidcConfig.redirectUrl);
  if (discoveryUrl) {
    oidcConfig.discoveryUrl = discoveryUrl;
  }
  if (clientId) {
    oidcConfig.clientId = clientId;
  }
  if (clientSecret) {
    oidcConfig.clientSecret = clientSecret;
  }
  if (redirectUri) {
    oidcConfig.redirectUri = redirectUri;
  }
  if (oidcScope) {
    oidcConfig.scope = oidcScope;
  }
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
  } else if (hasOidcBlock) {
    warnings.push("OIDC config present but no applicable generic values found");
  }

  const googleClientId = normalizeString(parsed.googleDrive.clientId);
  const googleClientSecret = normalizeString(parsed.googleDrive.clientSecret);
  if (googleClientId) {
    try {
      googleOAuth = googleClientManager.setOAuthClient({
        clientId: googleClientId,
        clientSecret: googleClientSecret,
      });
    } catch (error) {
      warnings.push(`Google OAuth config not applied: ${String(error)}`);
    }
  } else if (hasGoogleDriveBlock) {
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

export async function maybeSetAppConfig(): Promise<AppliedAppConfig | null> {
  if (typeof window === "undefined" || !window.localStorage) {
    return null;
  }

  const storage = window.localStorage;
  const hasOidcConfig = Boolean(storage.getItem(OIDC_STORAGE_KEY));
  const hasDriveConfig = Boolean(storage.getItem(GOOGLE_CLIENT_STORAGE_KEY));

  const settingsRaw = storage.getItem(SETTINGS_STORAGE_KEY);
  let settings: Record<string, unknown> = {};
  if (settingsRaw) {
    try {
      settings = JSON.parse(settingsRaw) as Record<string, unknown>;
    } catch (error) {
      console.warn("Failed to parse cloudAssistantSettings; resetting.", error);
      settings = {};
    }
  }
  if (typeof settings.agentEndpoint !== "string" || !settings.agentEndpoint) {
    const fallback = window.location?.origin?.trim() ?? "";
    if (fallback) {
      settings.agentEndpoint = fallback;
      storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
      console.info("Seeded agent endpoint in cloudAssistantSettings.");
    }
  } else {
    console.info("Agent endpoint already set; skipping seed.");
  }

  if (hasOidcConfig && hasDriveConfig) {
    console.info("OIDC and Google Drive configs already set; skipping app config load.");
    return null;
  }
  if (!hasOidcConfig) {
    console.info("OIDC config missing; attempting to load from app config.");
  } else {
    console.info("OIDC config already set; skipping.");
  }
  if (!hasDriveConfig) {
    console.info("Google Drive config missing; attempting to load from app config.");
  } else {
    console.info("Google Drive config already set; skipping.");
  }

  try {
    const applied = await setAppConfig();
    console.info("App config loaded.");
    return applied;
  } catch (error) {
    console.warn("Skipping app config preload", error);
    return null;
  }
}
