import { useEffect, useState } from "react";
import pkceChallenge from "pkce-challenge";
import * as oauth from "oauth4webapi";

import { getOidcConfig } from "./auth/oidcConfig";
import { appLogger } from "./lib/logging/runtime";
import type {
  OAuthTokenEndpointResponse,
  SimpleAuthJSONWithHelpers,
  StoredTokenResponse,
} from "./auth/types";

const STORAGE_KEY = "oidc-auth";
const PKCE_STATE_KEY = "oidc_pkce_state";
const PKCE_CODE_VERIFIER_KEY = "oidc_pkce_code_verifier";
const PKCE_NONCE_KEY = "oidc_pkce_nonce";

type DiscoveryDocument = {
  authorization_endpoint: string;
  token_endpoint: string;
  issuer?: string;
};

type AuthListener = (authData: SimpleAuthJSONWithHelpers | null) => void;

function redactIdentifier(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= 10) {
    return `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`;
  }
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

function sanitizeUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return value;
  }
}

function summarizeScope(scope: string): string[] {
  return scope
    .split(" ")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function hasClientSecret(clientSecret?: string): boolean {
  return Boolean(clientSecret && clientSecret.trim().length > 0);
}

async function readOAuthErrorResponse(response: Response): Promise<{
  error?: string;
  errorDescription?: string;
  errorUri?: string;
  rawBody?: string;
}> {
  try {
    const body = (await response.clone().text()).trim();
    if (!body) {
      return {};
    }
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const error =
        typeof parsed.error === "string" ? parsed.error : undefined;
      const errorDescription =
        typeof parsed.error_description === "string"
          ? parsed.error_description
          : undefined;
      const errorUri =
        typeof parsed.error_uri === "string" ? parsed.error_uri : undefined;
      return { error, errorDescription, errorUri };
    } catch {
      return { rawBody: body.slice(0, 500) };
    }
  } catch (error) {
    return { rawBody: `Failed to read error response: ${String(error)}` };
  }
}

function buildSimpleAuth(token: StoredTokenResponse): SimpleAuthJSONWithHelpers {
  const expiresAt = token.expires_at;
  return {
    accessToken: token.access_token,
    idToken: token.id_token,
    refreshToken: token.refresh_token,
    tokenType: token.token_type,
    scope: token.scope,
    expiresAt,
    isExpired: () =>
      typeof expiresAt === "number" ? Date.now() >= expiresAt : false,
    willExpireSoon: (thresholdSeconds = 60) =>
      typeof expiresAt === "number"
        ? Date.now() >= expiresAt - thresholdSeconds * 1000
        : false,
  };
}

function buildClient(config: ReturnType<typeof getOidcConfig>): oauth.Client {
  const client: oauth.Client = { client_id: config.clientId };
  if (config.clientSecret && config.clientSecret.trim().length > 0) {
    client.client_secret = config.clientSecret;
  } else {
    client.token_endpoint_auth_method = "none";
  }
  return client;
}

function normalizeTokenResponse(
  token: OAuthTokenEndpointResponse,
  existing?: StoredTokenResponse | null,
): StoredTokenResponse {
  const expiresAt =
    typeof token.expires_in === "number"
      ? Date.now() + token.expires_in * 1000
      : existing?.expires_at;
  return {
    ...existing,
    ...token,
    expires_at: expiresAt,
    refresh_token: token.refresh_token ?? existing?.refresh_token,
  };
}

let discoveryPromise: Promise<DiscoveryDocument> | null = null;

async function loadDiscovery(): Promise<DiscoveryDocument> {
  if (!discoveryPromise) {
    discoveryPromise = (async () => {
      const config = getOidcConfig();
      appLogger.info("Loading OIDC discovery document", {
        attrs: {
          scope: "auth.oidc",
          code: "OIDC_DISCOVERY_LOAD_START",
          discoveryUrl: sanitizeUrl(config.discoveryUrl),
          clientIdHint: redactIdentifier(config.clientId),
          redirectUri: sanitizeUrl(config.redirectUri),
        },
      });
      const response = await fetch(config.discoveryUrl);
      if (!response.ok) {
        appLogger.error("Failed to load OIDC discovery document", {
          attrs: {
            scope: "auth.oidc",
            code: "OIDC_DISCOVERY_LOAD_FAILED",
            discoveryUrl: sanitizeUrl(config.discoveryUrl),
            status: response.status,
            statusText: response.statusText,
          },
        });
        throw new Error(
          `Failed to load OIDC discovery document: ${response.status}`,
        );
      }
      const json = (await response.json()) as DiscoveryDocument;
      if (!json.authorization_endpoint || !json.token_endpoint) {
        appLogger.error("OIDC discovery document missing endpoints", {
          attrs: {
            scope: "auth.oidc",
            code: "OIDC_DISCOVERY_MISSING_ENDPOINTS",
            discoveryUrl: sanitizeUrl(config.discoveryUrl),
            hasAuthorizationEndpoint: Boolean(json.authorization_endpoint),
            hasTokenEndpoint: Boolean(json.token_endpoint),
          },
        });
        throw new Error("Discovery document missing required endpoints.");
      }
      appLogger.info("Loaded OIDC discovery document", {
        attrs: {
          scope: "auth.oidc",
          code: "OIDC_DISCOVERY_LOAD_SUCCESS",
          discoveryUrl: sanitizeUrl(config.discoveryUrl),
          authorizationEndpoint: sanitizeUrl(json.authorization_endpoint),
          tokenEndpoint: sanitizeUrl(json.token_endpoint),
        },
      });
      return json;
    })();
  }
  return discoveryPromise;
}

export class BrowserAuthAdapter {
  private readonly listeners = new Set<AuthListener>();

  /**
   * Handles the OAuth callback by exchanging the authorization code for tokens,
   * removing PKCE state from localStorage, and persisting the token response.
   */
  handleCallback = async () => {
    const callbackUrl = new URL(window.location.href);
    const callbackParams = callbackUrl.searchParams;
    const codeVerifier = window.localStorage.getItem(PKCE_CODE_VERIFIER_KEY);
    const storedState = window.localStorage.getItem(PKCE_STATE_KEY);
    const storedNonce = window.localStorage.getItem(PKCE_NONCE_KEY);

    appLogger.info("Handling OIDC callback", {
      attrs: {
        scope: "auth.oidc",
        code: "OIDC_CALLBACK_START",
        callbackPath: callbackUrl.pathname,
        callbackOrigin: callbackUrl.origin,
        hasAuthCode: callbackParams.has("code"),
        authCodeLength: callbackParams.get("code")?.length ?? 0,
        hasState: callbackParams.has("state"),
        hasScope: callbackParams.has("scope"),
        callbackError: callbackParams.get("error") ?? null,
        callbackErrorDescription:
          callbackParams.get("error_description") ?? null,
        callbackAuthUser: callbackParams.get("authuser") ?? null,
        callbackHostedDomain: callbackParams.get("hd") ?? null,
        hasStoredCodeVerifier: Boolean(codeVerifier),
        hasStoredState: Boolean(storedState),
        hasStoredNonce: Boolean(storedNonce),
      },
    });

    if (!codeVerifier || !storedState) {
      appLogger.error("OIDC callback missing PKCE verifier or state", {
        attrs: {
          scope: "auth.oidc",
          code: "OIDC_CALLBACK_MISSING_PKCE_STATE",
          hasStoredCodeVerifier: Boolean(codeVerifier),
          hasStoredState: Boolean(storedState),
        },
      });
      throw new Error("No code verifier or state found");
    }
    if (!storedNonce) {
      appLogger.error("OIDC callback missing nonce", {
        attrs: {
          scope: "auth.oidc",
          code: "OIDC_CALLBACK_MISSING_NONCE",
        },
      });
      throw new Error("No nonce found");
    }
    window.localStorage.removeItem(PKCE_CODE_VERIFIER_KEY);
    window.localStorage.removeItem(PKCE_STATE_KEY);
    window.localStorage.removeItem(PKCE_NONCE_KEY);

    const config = getOidcConfig();
    const discovery = await loadDiscovery();
    const authServer = discovery as oauth.AuthorizationServer;
    const client = buildClient(config);
    appLogger.info("OIDC callback configuration resolved", {
      attrs: {
        scope: "auth.oidc",
        code: "OIDC_CALLBACK_CONFIG",
        discoveryUrl: sanitizeUrl(config.discoveryUrl),
        redirectUri: sanitizeUrl(config.redirectUri),
        clientIdHint: redactIdentifier(config.clientId),
        hasClientSecret: hasClientSecret(config.clientSecret),
        tokenEndpointAuthMethod:
          client.token_endpoint_auth_method ?? "client_secret_basic(default)",
      },
    });
    const params = oauth.validateAuthResponse(
      authServer,
      client,
      callbackUrl,
      storedState,
    );
    if (oauth.isOAuth2Error(params)) {
      appLogger.error("OIDC callback response validation failed", {
        attrs: {
          scope: "auth.oidc",
          code: "OIDC_CALLBACK_VALIDATE_FAILED",
          oauthError: params.error,
          oauthErrorDescription: params.error_description,
          oauthErrorUri: params.error_uri,
        },
      });
      throw new Error(params.error_description ?? params.error);
    }
    appLogger.info("OIDC callback response validated", {
      attrs: {
        scope: "auth.oidc",
        code: "OIDC_CALLBACK_VALIDATE_SUCCESS",
        redirectUri: sanitizeUrl(config.redirectUri),
      },
    });

    appLogger.info("Requesting OIDC token exchange", {
      attrs: {
        scope: "auth.oidc",
        code: "OIDC_TOKEN_EXCHANGE_START",
        tokenEndpoint: sanitizeUrl(discovery.token_endpoint),
        redirectUri: sanitizeUrl(config.redirectUri),
        codeVerifierLength: codeVerifier.length,
        clientIdHint: redactIdentifier(config.clientId),
        hasClientSecret: hasClientSecret(config.clientSecret),
      },
    });
    const response = await oauth.authorizationCodeGrantRequest(
      authServer,
      client,
      params,
      config.redirectUri,
      codeVerifier,
    );
    if (!response.ok) {
      const oauthErrorResponse = await readOAuthErrorResponse(response);
      appLogger.error("OIDC token endpoint returned non-success response", {
        attrs: {
          scope: "auth.oidc",
          code: "OIDC_TOKEN_EXCHANGE_HTTP_ERROR",
          status: response.status,
          statusText: response.statusText,
          tokenEndpoint: sanitizeUrl(discovery.token_endpoint),
          oauthError: oauthErrorResponse.error,
          oauthErrorDescription: oauthErrorResponse.errorDescription,
          oauthErrorUri: oauthErrorResponse.errorUri,
          rawBody: oauthErrorResponse.rawBody,
        },
      });
    } else {
      appLogger.info("OIDC token endpoint responded", {
        attrs: {
          scope: "auth.oidc",
          code: "OIDC_TOKEN_EXCHANGE_HTTP_OK",
          status: response.status,
          tokenEndpoint: sanitizeUrl(discovery.token_endpoint),
        },
      });
    }

    const result = (await oauth.processAuthorizationCodeOpenIDResponse(
      authServer,
      client,
      response,
      storedNonce,
    )) as OAuthTokenEndpointResponse | oauth.OAuth2Error;

    if (oauth.isOAuth2Error(result)) {
      appLogger.error("OIDC token exchange failed", {
        attrs: {
          scope: "auth.oidc",
          code: "OIDC_TOKEN_EXCHANGE_FAILED",
          tokenEndpoint: sanitizeUrl(discovery.token_endpoint),
          oauthError: result.error,
          oauthErrorDescription: result.error_description,
          oauthErrorUri: result.error_uri,
        },
      });
      throw new Error(result.error_description ?? result.error);
    }

    appLogger.info("OIDC token exchange succeeded", {
      attrs: {
        scope: "auth.oidc",
        code: "OIDC_TOKEN_EXCHANGE_SUCCESS",
        hasAccessToken: Boolean(result.access_token),
        hasIDToken: Boolean(result.id_token),
        hasRefreshToken: Boolean(result.refresh_token),
        tokenType: result.token_type ?? null,
        expiresIn: result.expires_in ?? null,
        scopeCount: summarizeScope(result.scope ?? "").length,
      },
    });
    this.persist(result);
  };

  /**
   * Initiates the OAuth login flow by redirecting the browser to the authorization URL.
   * Stores PKCE code verifier and state in localStorage.
   */
  loginWithRedirect = async () => {
    const config = getOidcConfig();
    const discovery = await loadDiscovery();
    const { code_verifier, code_challenge } = await pkceChallenge();
    const state = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    const hasRefreshToken = Boolean(this.getTokenResponse()?.refresh_token);

    window.localStorage.setItem(PKCE_CODE_VERIFIER_KEY, code_verifier);
    window.localStorage.setItem(PKCE_STATE_KEY, state);
    window.localStorage.setItem(PKCE_NONCE_KEY, nonce);

    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", config.scope);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", code_challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("nonce", nonce);
    if (config.extraAuthParams) {
      Object.entries(config.extraAuthParams).forEach(([key, value]) => {
        if (key === "prompt" && value === "consent" && hasRefreshToken) {
          return;
        }
        url.searchParams.set(key, value);
      });
    }
    appLogger.info("Initiating OIDC login redirect", {
      attrs: {
        scope: "auth.oidc",
        code: "OIDC_LOGIN_REDIRECT",
        authorizationEndpoint: sanitizeUrl(discovery.authorization_endpoint),
        tokenEndpoint: sanitizeUrl(discovery.token_endpoint),
        redirectUri: sanitizeUrl(config.redirectUri),
        clientIdHint: redactIdentifier(config.clientId),
        hasClientSecret: hasClientSecret(config.clientSecret),
        scopeCount: summarizeScope(config.scope).length,
        hasExtraAuthParams: Boolean(config.extraAuthParams),
        hasRefreshToken,
        codeVerifierLength: code_verifier.length,
        codeChallengeLength: code_challenge.length,
      },
    });

    window.location.href = url.toString();
  };

  /**
   * Logs out the user by removing the token from localStorage and notifying listeners.
   */
  logout = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    this.listeners.forEach((listener) => listener(null));
  };

  /**
   * Initializes the adapter, refreshing tokens if they are about to expire.
   */
  init = async () => {
    if (this.simpleAuth?.willExpireSoon()) {
      await this.refresh();
    }
  };

  /**
   * Returns the current authentication state, or null if not authenticated.
   */
  get simpleAuth(): SimpleAuthJSONWithHelpers | null {
    const tokenResponse = this.getTokenResponse();
    return tokenResponse ? buildSimpleAuth(tokenResponse) : null;
  }

  /**
   * Refreshes the authentication tokens if a refresh token is available, and persists
   * the new token response.
   */
  refresh = async () => {
    const tokenResponse = this.getTokenResponse();
    if (!tokenResponse?.refresh_token) {
      appLogger.warn("OIDC refresh skipped because no refresh token is available", {
        attrs: {
          scope: "auth.oidc",
          code: "OIDC_REFRESH_SKIPPED_NO_REFRESH_TOKEN",
        },
      });
      return;
    }
    const config = getOidcConfig();
    const discovery = await loadDiscovery();
    const authServer = discovery as oauth.AuthorizationServer;
    const client = buildClient(config);

    appLogger.info("Refreshing OIDC token", {
      attrs: {
        scope: "auth.oidc",
        code: "OIDC_REFRESH_START",
        tokenEndpoint: sanitizeUrl(discovery.token_endpoint),
        clientIdHint: redactIdentifier(config.clientId),
        hasClientSecret: hasClientSecret(config.clientSecret),
      },
    });
    const response = await oauth.refreshTokenGrantRequest(
      authServer,
      client,
      tokenResponse.refresh_token,
    );
    if (!response.ok) {
      const oauthErrorResponse = await readOAuthErrorResponse(response);
      appLogger.warn("OIDC refresh request returned non-success response", {
        attrs: {
          scope: "auth.oidc",
          code: "OIDC_REFRESH_HTTP_ERROR",
          status: response.status,
          statusText: response.statusText,
          tokenEndpoint: sanitizeUrl(discovery.token_endpoint),
          oauthError: oauthErrorResponse.error,
          oauthErrorDescription: oauthErrorResponse.errorDescription,
          oauthErrorUri: oauthErrorResponse.errorUri,
          rawBody: oauthErrorResponse.rawBody,
        },
      });
    }
    const result = (await oauth.processRefreshTokenResponse(
      authServer,
      client,
      response,
    )) as OAuthTokenEndpointResponse | oauth.OAuth2Error;
    if (oauth.isOAuth2Error(result)) {
      appLogger.warn("OIDC refresh failed", {
        attrs: {
          scope: "auth.oidc",
          code: "OIDC_REFRESH_FAILED",
          oauthError: result.error,
          oauthErrorDescription: result.error_description,
          oauthErrorUri: result.error_uri,
        },
      });
      if (this.simpleAuth?.isExpired()) {
        this.logout();
      }
      return;
    }
    appLogger.info("OIDC refresh succeeded", {
      attrs: {
        scope: "auth.oidc",
        code: "OIDC_REFRESH_SUCCESS",
        hasAccessToken: Boolean(result.access_token),
        hasIDToken: Boolean(result.id_token),
        hasRefreshToken: Boolean(result.refresh_token),
        tokenType: result.token_type ?? null,
        expiresIn: result.expires_in ?? null,
      },
    });
    this.persist(result);
  };

  /**
   * Registers a callback to be invoked whenever the authentication state changes.
   */
  onAuthChange = (callback: AuthListener) => {
    const controller = new AbortController();
    this.listeners.add(callback);
    window.addEventListener(
      "storage",
      (event) => {
        if (event.key === STORAGE_KEY) {
          callback(
            event.newValue ? buildSimpleAuth(JSON.parse(event.newValue)) : null,
          );
        }
      },
      { signal: controller.signal },
    );
    return () => {
      this.listeners.delete(callback);
      controller.abort();
    };
  };

  private getTokenResponse(): StoredTokenResponse | null {
    const authData = window.localStorage.getItem(STORAGE_KEY);
    return authData ? (JSON.parse(authData) as StoredTokenResponse) : null;
  }

  private persist(tokenResponse: OAuthTokenEndpointResponse) {
    const stored = normalizeTokenResponse(tokenResponse, this.getTokenResponse());
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    const simpleAuth = this.simpleAuth;
    appLogger.info("Persisted OIDC auth state", {
      attrs: {
        scope: "auth.oidc",
        code: "OIDC_PERSIST_AUTH",
        hasAccessToken: Boolean(stored.access_token),
        hasIDToken: Boolean(stored.id_token),
        hasRefreshToken: Boolean(stored.refresh_token),
        tokenType: stored.token_type ?? null,
        scopeCount: summarizeScope(stored.scope ?? "").length,
        expiresAt: stored.expires_at ?? null,
      },
    });
    this.listeners.forEach((listener) => listener(simpleAuth));
  }
}

// This must be awaited in the client app initialization code
// (can't do it below because top-level await fails in our build)
const browserAdapter = new BrowserAuthAdapter();

export function getBrowserAdapter(): BrowserAuthAdapter {
  return browserAdapter;
}

/**
 * A simple hook that can be used to get the current auth data. Stays up to date as the
 * user's login state changes.
 */
export function useBrowserAuthData() {
  const [authData, setAuthData] = useState(
    () => getBrowserAdapter().simpleAuth,
  );

  useEffect(() => {
    return getBrowserAdapter().onAuthChange(setAuthData);
  }, []);

  return authData;
}
