export const APP_CONFIG_PATH_DEFAULT = "/configs/app-config.yaml";

export interface OidcGenericRuntimeConfig {
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
  issuer: string;
  redirectUrl: string;
  scopes: string[];
}

export interface OidcRuntimeConfig {
  clientExchange: boolean;
  generic: OidcGenericRuntimeConfig;
}

export interface GoogleDriveRuntimeConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

export interface RuntimeAppConfig {
  agentEndpoint: string;
  defaultRunnerEndpoint: string;
  oidc: OidcRuntimeConfig;
  googleDrive: GoogleDriveRuntimeConfig;
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

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const values = value
    .map((item) => asNonEmptyString(item))
    .filter((item): item is string => Boolean(item));
  return values;
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

function createDefaultRuntimeAppConfig(): RuntimeAppConfig {
  return {
    agentEndpoint: "",
    defaultRunnerEndpoint: "",
    oidc: {
      clientExchange: false,
      generic: createDefaultOidcGenericRuntimeConfig(),
    },
    googleDrive: {
      clientId: "",
      clientSecret: "",
      baseUrl: "",
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

    const oidc = asRecord(root.oidc);
    const oidcGeneric = asRecord(oidc?.generic);
    const drive = asRecord(root.googleDrive);

    parsed.agentEndpoint = asNonEmptyString(root.agentEndpoint);
    parsed.defaultRunnerEndpoint = asNonEmptyString(root.defaultRunnerEndpoint);

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

    if (drive) {
      parsed.googleDrive = {
        clientId: pickString(drive, ["clientId", "clientID"]),
        clientSecret: pickString(drive, ["clientSecret", "client_secret"]),
        baseUrl: asNonEmptyString(drive.baseUrl),
      };
    }

    return parsed;
  }
}
