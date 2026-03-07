import YAML from "yaml";

import type { OidcConfig } from "../auth/oidcConfig";
import { OIDC_STORAGE_KEY, oidcConfigManager } from "../auth/oidcConfig";
import { getOidcCallbackUrl, resolveAppUrl } from "./appBase";
import type {
  GoogleDriveAuthFlow,
  GoogleDriveAuthUxMode,
  GoogleOAuthClientConfig,
} from "./googleClientManager";
import {
  GOOGLE_CLIENT_STORAGE_KEY,
  googleClientManager,
} from "./googleClientManager";
import { agentEndpointManager } from "./agentEndpointManager";
import { appLogger } from "./logging/runtime";
import { getGoogleDriveBaseUrl, setGoogleDriveBaseUrl } from "./googleDriveRuntime";

type StoredRunner = {
  name: string;
  endpoint: string;
  reconnect: boolean;
};

export const SETTINGS_STORAGE_KEY = "cloudAssistantSettings";
const RUNNERS_STORAGE_KEY = "runme/runners";
const LEGACY_RUNNERS_STORAGE_KEY = "aisre/runners";
const DEFAULT_RUNNER_NAME_STORAGE_KEY = "runme/defaultRunner";
const LEGACY_DEFAULT_RUNNER_NAME_STORAGE_KEY = "aisre/defaultRunner";
const DEFAULT_RUNNER_NAME = "default";
export const APP_CONFIG_PATH_DEFAULT = "configs/app-configs.yaml";
export const APP_CONFIG_PREFER_LOCAL_STORAGE_KEY = "runme/app-config/prefer-local";

export type AppConfigApplyOptions = {
  preserveLocalConfiguration?: boolean;
};

export interface OidcGenericRuntimeConfig {
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
  issuer: string;
  redirectUrl: string;
  scopes: string[];
}

export interface OidcGoogleRuntimeConfig {
  clientId: string;
  clientSecret: string;
}

export interface OidcRuntimeConfig {
  clientExchange: boolean;
  generic: OidcGenericRuntimeConfig;
  google: OidcGoogleRuntimeConfig;
}

export interface GoogleDriveRuntimeConfig {
  clientId: string;
  baseUrl: string;
  authFlow: GoogleDriveAuthFlow;
  authUxMode: GoogleDriveAuthUxMode;
}

export interface ChatkitRuntimeConfig {
  domainKey: string;
}

export interface AgentRuntimeConfig {
  endpoint: string;
  defaultRunnerEndpoint: string;
}

export interface RuntimeAppConfig {
  agent: AgentRuntimeConfig;
  oidc: OidcRuntimeConfig;
  googleDrive: GoogleDriveRuntimeConfig;
  chatkit: ChatkitRuntimeConfig;
}

export type AppliedAppConfig = {
  url: string;
  oidc?: OidcConfig;
  googleOAuth?: GoogleOAuthClientConfig;
  agentEndpoint?: string;
  defaultRunnerEndpoint?: string;
  chatkitDomainKey?: string;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
}

function asBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function asGoogleDriveAuthFlow(value: unknown): GoogleDriveAuthFlow | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "implicit" || normalized === "pkce") {
    return normalized;
  }
  return undefined;
}

function asGoogleDriveAuthUxMode(
  value: unknown,
): GoogleDriveAuthUxMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "popup" || normalized === "redirect") {
    return normalized;
  }
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const values = value
    .map((item) => asNonEmptyString(item))
    .filter((item): item is string => Boolean(item));
  return values;
}

function readSettingsFromStorage(storage: Storage): Record<string, unknown> {
  const settingsRaw = storage.getItem(SETTINGS_STORAGE_KEY);
  if (!settingsRaw) {
    return {};
  }
  try {
    return JSON.parse(settingsRaw) as Record<string, unknown>;
  } catch (error) {
    appLogger.warn("Failed to parse cloudAssistantSettings; resetting.", {
      attrs: {
        scope: "config.app",
        code: "APP_CONFIG_SETTINGS_PARSE_FAILED",
        error: String(error),
      },
    });
    return {};
  }
}

function writeSettingsToStorage(
  storage: Storage,
  settings: Record<string, unknown>,
): void {
  storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

export function resolveDefaultRunnerEndpointFallback(): string {
  if (typeof window === "undefined") {
    return "";
  }
  const protocol = window.location.protocol === "http:" ? "ws:" : "wss:";
  return `${protocol}//${window.location.host}/ws`;
}

function readStoredRunnerEndpoint(storage: Storage): string | undefined {
  const raw =
    storage.getItem(RUNNERS_STORAGE_KEY) ??
    storage.getItem(LEGACY_RUNNERS_STORAGE_KEY);
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return undefined;
    }

    const defaultRunnerName = normalizeString(
      storage.getItem(DEFAULT_RUNNER_NAME_STORAGE_KEY) ??
        storage.getItem(LEGACY_DEFAULT_RUNNER_NAME_STORAGE_KEY),
    );

    const normalized = parsed
      .map((item) => {
        const runner = asRecord(item);
        if (!runner) {
          return null;
        }
        const name = normalizeString(runner.name);
        const endpoint = normalizeString(runner.endpoint);
        if (!name || !endpoint) {
          return null;
        }
        return { name, endpoint };
      })
      .filter((item): item is { name: string; endpoint: string } =>
        Boolean(item),
      );

    if (normalized.length === 0) {
      return undefined;
    }

    if (defaultRunnerName) {
      const defaultRunner = normalized.find(
        (runner) => runner.name === defaultRunnerName,
      );
      if (defaultRunner) {
        return defaultRunner.endpoint;
      }
    }

    return normalized[0].endpoint;
  } catch (error) {
    appLogger.warn("Failed to parse runners storage", {
      attrs: {
        scope: "config.app",
        code: "APP_CONFIG_RUNNERS_PARSE_FAILED",
        error: String(error),
      },
    });
    return undefined;
  }
}

function hasConfiguredRunners(storage: Storage): boolean {
  if (readStoredRunnerEndpoint(storage)) {
    return true;
  }
  const settings = readSettingsFromStorage(storage);
  const settingsWebApp = asRecord(settings.webApp);
  return Boolean(normalizeString(settingsWebApp?.runner));
}

function seedDefaultRunner(storage: Storage, endpoint: string): void {
  const runner: StoredRunner = {
    name: DEFAULT_RUNNER_NAME,
    endpoint,
    reconnect: true,
  };

  storage.setItem(RUNNERS_STORAGE_KEY, JSON.stringify([runner]));
  storage.removeItem(LEGACY_RUNNERS_STORAGE_KEY);
  storage.setItem(DEFAULT_RUNNER_NAME_STORAGE_KEY, runner.name);
  storage.removeItem(LEGACY_DEFAULT_RUNNER_NAME_STORAGE_KEY);
}

export function getConfiguredAgentEndpoint(): string {
  return agentEndpointManager.get();
}

export function getConfiguredDefaultRunnerEndpoint(): string {
  if (typeof window === "undefined" || !window.localStorage) {
    return resolveDefaultRunnerEndpointFallback();
  }

  const storage = window.localStorage;
  const storedRunnerEndpoint = readStoredRunnerEndpoint(storage);
  if (storedRunnerEndpoint) {
    return storedRunnerEndpoint;
  }

  const settings = readSettingsFromStorage(storage);
  const settingsWebApp = asRecord(settings.webApp);
  return (
    normalizeString(settingsWebApp?.runner) ??
    resolveDefaultRunnerEndpointFallback()
  );
}

export function resolveDefaultChatKitDomainKeyFallback(): string {
  const envValue = normalizeString(import.meta.env.VITE_CHATKIT_DOMAIN_KEY);
  if (envValue) {
    return envValue;
  }
  if (
    typeof window !== "undefined" &&
    window.location.hostname === "localhost"
  ) {
    return "domain_pk_localhost_dev";
  }
  return "domain_pk_68f8054e7da081908cc1972e9167ec270895bf04413e753b";
}

function readStoredChatKitDomainKey(storage: Storage): string | undefined {
  const settings = readSettingsFromStorage(storage);
  const settingsChatkit = asRecord(settings.chatkit);
  return normalizeString(settingsChatkit?.domainKey);
}

export function getConfiguredChatKitDomainKey(): string {
  if (typeof window === "undefined" || !window.localStorage) {
    return resolveDefaultChatKitDomainKeyFallback();
  }

  return (
    readStoredChatKitDomainKey(window.localStorage) ??
    resolveDefaultChatKitDomainKeyFallback()
  );
}

function pickString(
  source: Record<string, unknown>,
  keys: string[],
): string {
  for (const key of keys) {
    const value = asNonEmptyString(source[key]);
    if (value) {
      return value;
    }
  }
  return "";
}

function createDefaultOidcGenericRuntimeConfig(): OidcGenericRuntimeConfig {
  return {
    clientId: "",
    clientSecret: "",
    discoveryUrl: "",
    issuer: "",
    redirectUrl: "",
    scopes: [],
  };
}

function createDefaultOidcGoogleRuntimeConfig(): OidcGoogleRuntimeConfig {
  return {
    clientId: "",
    clientSecret: "",
  };
}

function createDefaultRuntimeAppConfig(): RuntimeAppConfig {
  return {
    agent: {
      endpoint: "",
      defaultRunnerEndpoint: "",
    },
    oidc: {
      clientExchange: false,
      generic: createDefaultOidcGenericRuntimeConfig(),
      google: createDefaultOidcGoogleRuntimeConfig(),
    },
    googleDrive: {
      clientId: "",
      baseUrl: "",
      authFlow: "implicit",
      authUxMode: "popup",
    },
    chatkit: {
      domainKey: "",
    },
  };
}

/**
 * RuntimeAppConfigSchema normalizes untyped input (for example parsed YAML)
 * into the supported RuntimeAppConfig shape.
 */
export class RuntimeAppConfigSchema {
  static fromUnknown(value: unknown): RuntimeAppConfig {
    const parsed = createDefaultRuntimeAppConfig();
    const root = asRecord(value);
    if (!root) {
      return parsed;
    }

    const agent = asRecord(root.agent);
    const oidc = asRecord(root.oidc);
    const oidcGeneric = asRecord(oidc?.generic);
    const oidcGoogle = asRecord(oidc?.google);
    const drive = asRecord(root.googleDrive);
    const chatkit = asRecord(root.chatkit);

    parsed.agent = {
      endpoint:
        pickString(agent ?? {}, ["endpoint", "agentEndpoint"]) ||
        asNonEmptyString(root.agentEndpoint),
      defaultRunnerEndpoint:
        pickString(agent ?? {}, ["defaultRunnerEndpoint", "runnerEndpoint"]) ||
        asNonEmptyString(root.defaultRunnerEndpoint),
    };

    if (oidc) {
      parsed.oidc.clientExchange = asBoolean(oidc.clientExchange);
    }
    if (oidcGeneric) {
      parsed.oidc.generic = {
        clientId: pickString(oidcGeneric, ["clientId", "clientID"]),
        clientSecret: pickString(oidcGeneric, [
          "clientSecret",
          "client_secret",
        ]),
        discoveryUrl: pickString(oidcGeneric, ["discoveryUrl", "discoveryURL"]),
        issuer: pickString(oidcGeneric, ["issuer"]),
        redirectUrl: pickString(oidcGeneric, ["redirectUrl", "redirectURL"]),
        scopes: asStringArray(oidcGeneric.scopes),
      };
    }
    if (oidcGoogle) {
      parsed.oidc.google = {
        clientId: pickString(oidcGoogle, ["clientId", "clientID"]),
        clientSecret: pickString(oidcGoogle, ["clientSecret", "client_secret"]),
      };
    }

    if (drive) {
      const authFlow =
        asGoogleDriveAuthFlow(
          drive.authFlow ?? drive.auth_flow ?? drive.oauthFlow ?? drive.flow,
        ) ?? "implicit";
      const authUxMode =
        asGoogleDriveAuthUxMode(
          drive.authUxMode ??
            drive.auth_ux_mode ??
            drive.oauthUxMode ??
            drive.uxMode,
        ) ?? (authFlow === "pkce" ? "redirect" : "popup");
      parsed.googleDrive = {
        clientId: pickString(drive, ["clientId", "clientID"]),
        baseUrl: asNonEmptyString(drive.baseUrl),
        authFlow,
        authUxMode,
      };
    }

    if (chatkit) {
      parsed.chatkit = {
        domainKey: pickString(chatkit, ["domainKey", "domain_key"]),
      };
    }

    return parsed;
  }
}

export function getDefaultAppConfigUrl(): string {
  if (typeof window === "undefined") {
    return APP_CONFIG_PATH_DEFAULT;
  }
  return resolveAppUrl(APP_CONFIG_PATH_DEFAULT).toString();
}

export function applyAppConfig(
  rawConfig: unknown,
  url: string,
  options?: AppConfigApplyOptions,
): AppliedAppConfig {
  if (!isRecord(rawConfig)) {
    throw new Error("App config is empty or invalid");
  }
  const preserveLocalConfiguration = Boolean(
    options?.preserveLocalConfiguration,
  );
  const localStorageRef =
    typeof window !== "undefined" && window.localStorage
      ? window.localStorage
      : null;
  const hasLocalOidcConfig = Boolean(
    localStorageRef?.getItem(OIDC_STORAGE_KEY),
  );
  const hasLocalDriveConfig = Boolean(
    localStorageRef?.getItem(GOOGLE_CLIENT_STORAGE_KEY),
  );
  const hasLocalDriveRuntimeBaseUrl = Boolean(getGoogleDriveBaseUrl());

  const parsed = RuntimeAppConfigSchema.fromUnknown(rawConfig);
  const hasOidcBlock = isRecord(rawConfig.oidc);
  const rawOidc = asRecord(rawConfig.oidc);
  const hasOidcGoogleBlock = isRecord(rawOidc?.google);
  const hasGoogleDriveBlock = isRecord(rawConfig.googleDrive);
  const hasChatkitBlock = isRecord(rawConfig.chatkit);
  const warnings: string[] = [];
  let oidc: OidcConfig | undefined;
  let googleOAuth: GoogleOAuthClientConfig | undefined;
  let agentEndpoint: string | undefined;
  let defaultRunnerEndpoint: string | undefined;
  let chatkitDomainKey: string | undefined;

  const oidcConfig: Partial<OidcConfig> = {};
  const genericOidcConfig = parsed.oidc.generic;
  const googleOidcConfig = parsed.oidc.google;
  const googleOidcClientId = normalizeString(googleOidcConfig.clientId);
  const googleOidcClientSecret = normalizeString(googleOidcConfig.clientSecret);
  const oidcScope =
    genericOidcConfig.scopes.length > 0
      ? genericOidcConfig.scopes.join(" ")
      : undefined;
  const discoveryUrl = normalizeString(genericOidcConfig.discoveryUrl);
  const clientId =
    googleOidcClientId ?? normalizeString(genericOidcConfig.clientId);
  const clientSecret =
    googleOidcClientSecret ?? normalizeString(genericOidcConfig.clientSecret);
  const redirectUri = normalizeString(genericOidcConfig.redirectUrl);
  const configuredChatkitDomainKey = normalizeString(parsed.chatkit.domainKey);
  const skipOidcFromConfig =
    preserveLocalConfiguration && hasLocalOidcConfig;
  if (skipOidcFromConfig) {
    try {
      oidc = oidcConfigManager.getConfig();
    } catch {
      oidc = undefined;
    }
  } else {
    if (hasOidcGoogleBlock) {
      oidcConfigManager.setGoogleDefaults();
    }
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
        oidcConfig.redirectUri = getOidcCallbackUrl();
      }
      try {
        oidc = oidcConfigManager.setConfig(oidcConfig);
      } catch (error) {
        warnings.push(`OIDC config not applied: ${String(error)}`);
      }
    } else if (hasOidcGoogleBlock) {
      warnings.push("OIDC Google config missing clientID/clientId");
    } else if (hasOidcBlock) {
      warnings.push("OIDC config present but no applicable generic values found");
    }
  }

  const googleClientId = normalizeString(parsed.googleDrive.clientId);
  const googleAuthFlow = parsed.googleDrive.authFlow;
  const googleAuthUxMode = parsed.googleDrive.authUxMode;
  const skipGoogleDriveFromConfig =
    preserveLocalConfiguration && hasLocalDriveConfig;
  if (skipGoogleDriveFromConfig) {
    googleOAuth = googleClientManager.getOAuthClient();
  } else {
    if (googleClientId) {
      try {
        googleOAuth = googleClientManager.setOAuthClient({
          clientId: googleClientId,
          authFlow: googleAuthFlow,
          authUxMode: googleAuthUxMode,
        });
      } catch (error) {
        warnings.push(`Google OAuth config not applied: ${String(error)}`);
      }
    } else if (hasGoogleDriveBlock) {
      warnings.push("Google Drive config missing clientID/clientId");
    }
  }
  if (
    parsed.googleDrive.baseUrl &&
    !(preserveLocalConfiguration && hasLocalDriveRuntimeBaseUrl)
  ) {
    setGoogleDriveBaseUrl(parsed.googleDrive.baseUrl);
  }

  if (localStorageRef) {
    const settings = readSettingsFromStorage(localStorageRef);
    const settingsWebApp = asRecord(settings.webApp);
    const settingsChatkit = asRecord(settings.chatkit);
    const configAgentEndpoint = normalizeString(parsed.agent.endpoint);
    const hadAgentOverride = agentEndpointManager.hasOverride();
    agentEndpointManager.setDefaultEndpoint(configAgentEndpoint);
    if (!configAgentEndpoint && !hadAgentOverride) {
      warnings.push(
        "App config missing agent.endpoint; defaulting to window.location.origin",
      );
    }
    agentEndpoint = agentEndpointManager.get();

    const configRunnerEndpoint = normalizeString(
      parsed.agent.defaultRunnerEndpoint,
    );
    const hasStoredRunnerEndpoint = hasConfiguredRunners(localStorageRef);

    if (!hasStoredRunnerEndpoint && configRunnerEndpoint) {
      defaultRunnerEndpoint = configRunnerEndpoint;
      seedDefaultRunner(localStorageRef, configRunnerEndpoint);

      const webApp = {
        ...(settingsWebApp ?? {}),
        runner: configRunnerEndpoint,
      };
      settings.webApp = webApp;
      writeSettingsToStorage(localStorageRef, settings);
    } else if (hasStoredRunnerEndpoint) {
      defaultRunnerEndpoint = readStoredRunnerEndpoint(localStorageRef);
    }

    const storedChatkitDomainKey = readStoredChatKitDomainKey(localStorageRef);
    if (!storedChatkitDomainKey && configuredChatkitDomainKey) {
      chatkitDomainKey = configuredChatkitDomainKey;
      settings.chatkit = {
        ...(settingsChatkit ?? {}),
        domainKey: configuredChatkitDomainKey,
      };
      writeSettingsToStorage(localStorageRef, settings);
    } else {
      chatkitDomainKey = storedChatkitDomainKey;
    }
  }

  if (!chatkitDomainKey) {
    chatkitDomainKey = configuredChatkitDomainKey;
  }
  if (hasChatkitBlock && !configuredChatkitDomainKey) {
    warnings.push("ChatKit config missing domainKey");
  }

  return {
    url,
    oidc,
    googleOAuth,
    agentEndpoint,
    defaultRunnerEndpoint,
    chatkitDomainKey,
    warnings,
  };
}

export async function setAppConfig(
  url?: string,
  options?: AppConfigApplyOptions,
): Promise<AppliedAppConfig> {
  const resolvedUrl = normalizeString(url) ?? getDefaultAppConfigUrl();
  const response = await fetch(resolvedUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch app config (${response.status} ${response.statusText})`,
    );
  }
  const text = await response.text();
  const parsed = YAML.parse(text) as unknown;
  return applyAppConfig(parsed, resolvedUrl, options);
}

export function isLocalConfigPreferredOnLoad(): boolean {
  if (typeof window === "undefined" || !window.localStorage) {
    return false;
  }
  return (
    normalizeString(
      window.localStorage.getItem(APP_CONFIG_PREFER_LOCAL_STORAGE_KEY),
    ) === "true"
  );
}

export function setLocalConfigPreferredOnLoad(preferLocal: boolean): boolean {
  if (typeof window === "undefined" || !window.localStorage) {
    return preferLocal;
  }
  window.localStorage.setItem(
    APP_CONFIG_PREFER_LOCAL_STORAGE_KEY,
    preferLocal ? "true" : "false",
  );
  return preferLocal;
}

export function disableAppConfigOverridesOnLoad(): boolean {
  return setLocalConfigPreferredOnLoad(true);
}

export function enableAppConfigOverridesOnLoad(): boolean {
  return setLocalConfigPreferredOnLoad(false);
}

export async function maybeSetAppConfig(): Promise<AppliedAppConfig | null> {
  if (typeof window === "undefined" || !window.localStorage) {
    return null;
  }
  const preserveLocalConfiguration = isLocalConfigPreferredOnLoad();
  appLogger.info("Attempting app config preload", {
    attrs: {
      scope: "config.app",
      code: "APP_CONFIG_PRELOAD_ATTEMPT",
      preserveLocalConfiguration,
    },
  });

  try {
    const applied = await setAppConfig(undefined, {
      preserveLocalConfiguration,
    });
    appLogger.info("App config loaded.", {
      attrs: {
        scope: "config.app",
        code: "APP_CONFIG_LOADED",
        url: applied.url,
        warningCount: applied.warnings.length,
      },
    });
    return applied;
  } catch (error) {
    appLogger.warn("Skipping app config preload", {
      attrs: {
        scope: "config.app",
        code: "APP_CONFIG_PRELOAD_FAILED",
        error: String(error),
      },
    });
    return null;
  }
}
