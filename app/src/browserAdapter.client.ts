import { useEffect, useState } from "react";
import pkceChallenge from "pkce-challenge";
import * as oauth from "oauth4webapi";

import { getOidcConfig } from "./auth/oidcConfig";
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
      const response = await fetch(config.discoveryUrl);
      if (!response.ok) {
        throw new Error(
          `Failed to load OIDC discovery document: ${response.status}`,
        );
      }
      const json = (await response.json()) as DiscoveryDocument;
      if (!json.authorization_endpoint || !json.token_endpoint) {
        throw new Error("Discovery document missing required endpoints.");
      }
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
    const codeVerifier = window.localStorage.getItem(PKCE_CODE_VERIFIER_KEY);
    const storedState = window.localStorage.getItem(PKCE_STATE_KEY);
    const storedNonce = window.localStorage.getItem(PKCE_NONCE_KEY);
    if (!codeVerifier || !storedState) {
      throw new Error("No code verifier or state found");
    }
    if (!storedNonce) {
      throw new Error("No nonce found");
    }
    window.localStorage.removeItem(PKCE_CODE_VERIFIER_KEY);
    window.localStorage.removeItem(PKCE_STATE_KEY);
    window.localStorage.removeItem(PKCE_NONCE_KEY);

    const config = getOidcConfig();
    const discovery = await loadDiscovery();
    const authServer = discovery as oauth.AuthorizationServer;
    const client = buildClient(config);

    const callbackUrl = new URL(window.location.href);
    const params = oauth.validateAuthResponse(
      authServer,
      client,
      callbackUrl,
      storedState,
    );
    if (oauth.isOAuth2Error(params)) {
      throw new Error(params.error_description ?? params.error);
    }

    const response = await oauth.authorizationCodeGrantRequest(
      authServer,
      client,
      params,
      config.redirectUri,
      codeVerifier,
    );

    const result = (await oauth.processAuthorizationCodeOpenIDResponse(
      authServer,
      client,
      response,
      storedNonce,
    )) as OAuthTokenEndpointResponse | oauth.OAuth2Error;

    if (oauth.isOAuth2Error(result)) {
      throw new Error(result.error_description ?? result.error);
    }

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
        url.searchParams.set(key, value);
      });
    }

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
    if (!tokenResponse?.refresh_token) return;
    const config = getOidcConfig();
    const discovery = await loadDiscovery();
    const authServer = discovery as oauth.AuthorizationServer;
    const client = buildClient(config);

    const response = await oauth.refreshTokenGrantRequest(
      authServer,
      client,
      tokenResponse.refresh_token,
    );
    const result = (await oauth.processRefreshTokenResponse(
      authServer,
      client,
      response,
    )) as OAuthTokenEndpointResponse | oauth.OAuth2Error;
    if (oauth.isOAuth2Error(result)) {
      if (this.simpleAuth?.isExpired()) {
        this.logout();
      }
      return;
    }
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
