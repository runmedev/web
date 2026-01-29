export type OidcConfig = {
  discoveryUrl: string;
  clientId: string;
  scope: string;
  redirectUri: string;
  extraAuthParams?: Record<string, string>;
};

function env(name: string): string | undefined {
  const value = import.meta.env[name as keyof ImportMetaEnv];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function getOidcConfig(): OidcConfig {
  const discoveryUrl =
    env("VITE_OIDC_DISCOVERY_URL") ??
    env("VITE_AUTHAPI_DISCOVERY_URL") ??
    "";
  const clientId =
    env("VITE_OIDC_CLIENT_ID") ?? env("VITE_OAUTH_CLIENT_ID") ?? "";
  const scope = env("VITE_OIDC_SCOPE") ?? env("VITE_OAUTH_SCOPE") ?? "";
  const redirectUri =
    env("VITE_OIDC_REDIRECT_URI") ??
    new URL("/oidc/callback", window.location.origin).toString();

  if (!discoveryUrl) {
    throw new Error("Missing VITE_OIDC_DISCOVERY_URL");
  }
  if (!clientId) {
    throw new Error("Missing VITE_OIDC_CLIENT_ID");
  }
  if (!scope) {
    throw new Error("Missing VITE_OIDC_SCOPE");
  }

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
    scope,
    redirectUri,
    extraAuthParams: Object.keys(extraAuthParams).length
      ? extraAuthParams
      : undefined,
  };
}
