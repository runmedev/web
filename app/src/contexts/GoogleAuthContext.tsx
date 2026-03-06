import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import pkceChallenge from "pkce-challenge";
import { googleClientManager } from "../lib/googleClientManager";
import {
  APP_ROUTE_PATHS,
  getGoogleDriveOAuthCallbackUrl,
} from "../lib/appBase";
import { appLogger } from "../lib/logging/runtime";

// N.B. I couldn't make sharing work with the more restrictive "https://www.googleapis.com/auth/drive.file"
// scope. In particular, I couldn't quite figure out how to share a link with a user and then have that
// user go through the Drive Picker flow to associate that file with the app. So for now we use the broader
// drive scope to give the app access to all of the user's files.
export const DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive",  
  "https://www.googleapis.com/auth/drive.install",
];

const STORAGE_KEY = "runme/google-auth/token";
const LEGACY_STORAGE_KEY = "aisre/google-auth/token";
const PKCE_STATE_KEY = "runme/google-auth/pkce-state";
const PKCE_CODE_VERIFIER_KEY = "runme/google-auth/pkce-code-verifier";
const PKCE_RETURN_TO_KEY = "runme/google-auth/pkce-return-to";

interface AccessTokenInfo {
  token: string;
  expiresAt: number;
}

interface GoogleAuthContextType {
  ensureAccessToken: () => Promise<string>;
  setAccessToken: (token: string, expiresIn?: number) => void;
}

type PendingHandlers = {
  resolve: (token: string) => void;
  reject: (error: unknown) => void;
};

interface TokenClient {
  callback: (response: AccessTokenResponse) => void;
  requestAccessToken: (options?: { prompt?: string }) => void;
}

interface AccessTokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface GoogleOAuth {
  initTokenClient: (options: {
    client_id: string;
    scope: string;
    callback: (response: AccessTokenResponse) => void;
  }) => TokenClient;
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: GoogleOAuth;
      };
    };
  }
}

const GoogleAuthContext = createContext<GoogleAuthContextType | undefined>(
  undefined,
);

// eslint-disable-next-line react-refresh/only-export-components
export function useGoogleAuth() {
  const ctx = useContext(GoogleAuthContext);
  if (!ctx) {
    throw new Error("useGoogleAuth must be used within a GoogleAuthProvider");
  }
  return ctx;
}

const REFRESH_MARGIN_MS = 60_000;

// GoogleAuthProvider owns all OAuth state for the app. It exposes a small
// surface (ensureAccessToken / setAccessToken) through context so the rest of
// the codebase never has to think about how tokens are minted, refreshed, or
// cached.
function loadStoredToken(): AccessTokenInfo | null {
  try {
    const raw =
      window.localStorage.getItem(STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<AccessTokenInfo> | null;
    if (!parsed?.token || typeof parsed.token !== "string") {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      return null;
    }
    if (typeof parsed.expiresAt !== "number") {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      return null;
    }
    if (parsed.expiresAt <= Date.now() + REFRESH_MARGIN_MS) {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      return null;
    }
    return {
      token: parsed.token,
      expiresAt: parsed.expiresAt,
    };
  } catch (error) {
    console.error("Failed to read Google auth token from storage", error);
    return null;
  }
}

export function GoogleAuthProvider({ children }: { children: ReactNode }) {
  // tokenInfo lives in React state so rerenders propagate an updated token to
  // any components that care about it. We store both the raw token and the
  // computed expiration time so we can avoid making unnecessary OAuth round
  // trips. When the token changes, React will re-render this provider and
  // consequently re-run any hooks that depend on tokenInfo.
  const [tokenInfo, setTokenInfo] = useState<AccessTokenInfo | null>(
    loadStoredToken,
  );

  // The remaining mutable pieces do not participate in rendering, so they are
  // stored in refs instead of state. This keeps React from re-rendering whenever
  // these values change and also gives us stable references across function
  // calls.
  const tokenInfoRef = useRef<AccessTokenInfo | null>(null);
  const tokenClientRef = useRef<TokenClient | null>(null);
  const oauthClientIdRef = useRef<string | null>(null);
  const handlersRef = useRef<PendingHandlers | null>(null);
  const pendingPromiseRef = useRef<Promise<string> | null>(null);
  const scriptPromiseRef = useRef<Promise<void> | null>(null);
  const callbackPromiseRef = useRef<Promise<void> | null>(null);
  const callbackErrorRef = useRef<unknown>(null);

  // useCallback memoises the function instance so consumers receive a stable
  // reference between renders. That is important because the callback is passed
  // to other hooks and stored in refs; without useCallback React would recreate
  // the function every render, potentially breaking equality checks or causing
  // needless effect cleanups.
  const setAccessToken = useCallback((token: string, expiresIn = 3600) => {
    if (!token) {
      setTokenInfo(null);
      tokenInfoRef.current = null;
      try {
        window.localStorage.removeItem(STORAGE_KEY);
        window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch (error) {
        console.error("Failed to clear Google auth token", error);
      }
      return;
    }

    const expiresAt = Date.now() + (expiresIn * 1000 - REFRESH_MARGIN_MS);
    const info = { token, expiresAt };
    setTokenInfo(info);
    tokenInfoRef.current = info;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(info));
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch (error) {
      console.error("Failed to persist Google auth token", error);
    }
  }, []);

  const clearPkceState = useCallback(() => {
    try {
      window.localStorage.removeItem(PKCE_STATE_KEY);
      window.localStorage.removeItem(PKCE_CODE_VERIFIER_KEY);
      window.localStorage.removeItem(PKCE_RETURN_TO_KEY);
    } catch (error) {
      console.error("Failed to clear Google PKCE state", error);
    }
  }, []);

  const exchangeAuthorizationCode = useCallback(
    async (code: string, codeVerifier: string): Promise<AccessTokenResponse> => {
      const { clientId, clientSecret } = googleClientManager.getOAuthClient();
      if (!clientId?.trim()) {
        throw new Error("Google OAuth client is not configured.");
      }

      const body = new URLSearchParams({
        client_id: clientId,
        code,
        code_verifier: codeVerifier,
        redirect_uri: getGoogleDriveOAuthCallbackUrl(),
        grant_type: "authorization_code",
      });
      if (clientSecret?.trim()) {
        body.set("client_secret", clientSecret.trim());
      }

      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });

      let token: AccessTokenResponse | null = null;
      try {
        token = (await response.json()) as AccessTokenResponse;
      } catch {
        token = null;
      }

      if (!response.ok) {
        throw new Error(
          token?.error_description ??
            token?.error ??
            `Google OAuth token exchange failed (${response.status})`,
        );
      }

      return token ?? {};
    },
    [],
  );

  const handlePkceCallbackIfPresent = useCallback(async () => {
    const callbackPath = new URL(getGoogleDriveOAuthCallbackUrl()).pathname;
    if (window.location.pathname !== callbackPath) {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const oauthError = params.get("error");
    if (oauthError) {
      const message =
        params.get("error_description") ?? `Google OAuth failed: ${oauthError}`;
      clearPkceState();
      throw new Error(message);
    }

    const code = params.get("code");
    const state = params.get("state");
    if (!code && !state) {
      return;
    }

    const storedState = window.localStorage.getItem(PKCE_STATE_KEY);
    const codeVerifier = window.localStorage.getItem(PKCE_CODE_VERIFIER_KEY);
    const returnTo =
      window.localStorage.getItem(PKCE_RETURN_TO_KEY) ?? APP_ROUTE_PATHS.home;

    if (!code || !state || !storedState || !codeVerifier) {
      clearPkceState();
      throw new Error("Google OAuth callback is missing required PKCE state.");
    }
    if (state !== storedState) {
      clearPkceState();
      throw new Error("Google OAuth callback state mismatch.");
    }

    const tokenResponse = await exchangeAuthorizationCode(code, codeVerifier);
    if (tokenResponse.error || !tokenResponse.access_token) {
      clearPkceState();
      throw new Error(
        tokenResponse.error_description ??
          tokenResponse.error ??
          "Failed to obtain access token",
      );
    }

    setAccessToken(
      tokenResponse.access_token,
      tokenResponse.expires_in ?? 3600,
    );
    clearPkceState();
    window.history.replaceState(null, "", returnTo);
  }, [clearPkceState, exchangeAuthorizationCode, setAccessToken]);

  const startPkceRedirect = useCallback(async () => {
    const { clientId } = googleClientManager.getOAuthClient();
    if (!clientId?.trim()) {
      throw new Error("Google OAuth client is not configured.");
    }

    const { code_verifier: codeVerifier, code_challenge: codeChallenge } =
      await pkceChallenge();
    const state = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
    const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;

    window.localStorage.setItem(PKCE_CODE_VERIFIER_KEY, codeVerifier);
    window.localStorage.setItem(PKCE_STATE_KEY, state);
    window.localStorage.setItem(PKCE_RETURN_TO_KEY, returnTo);

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", getGoogleDriveOAuthCallbackUrl());
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", DRIVE_SCOPES.join(" "));
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("include_granted_scopes", "true");

    // Force consent only for first-time grants. Re-auth attempts can stay silent.
    if (!tokenInfoRef.current?.token) {
      authUrl.searchParams.set("prompt", "consent");
    }

    window.location.assign(authUrl.toString());
  }, []);

  useEffect(() => {
    tokenInfoRef.current = tokenInfo;
  }, [tokenInfo]);

  useEffect(() => {
    callbackErrorRef.current = null;
    const pending = handlePkceCallbackIfPresent().catch((error) => {
      callbackErrorRef.current = error;
      appLogger.error("Failed to handle Google Drive OAuth callback", {
        attrs: {
          scope: "storage.drive.auth",
          code: "DRIVE_AUTH_CALLBACK_FAILED",
          error: String(error),
        },
      });
    });
    callbackPromiseRef.current = pending.finally(() => {
      callbackPromiseRef.current = null;
    });
  }, [handlePkceCallbackIfPresent]);

  // Loads the Google Identity Services script exactly once. We memoise the
  // function so callers share the same pending promise, and we stash the promise
  // itself in scriptPromiseRef so multiple callers can await the same work.
  const ensureScriptLoaded = useCallback(() => {
    if (window.google?.accounts?.oauth2?.initTokenClient) {
      return Promise.resolve();
    }

    if (!scriptPromiseRef.current) {
      scriptPromiseRef.current = new Promise<void>((resolve, reject) => {
        const existingScript = document.querySelector<HTMLScriptElement>(
          'script[src="https://accounts.google.com/gsi/client"]',
        );

        if (existingScript) {
          existingScript.addEventListener("load", () => resolve(), {
            once: true,
          });
          existingScript.addEventListener("error", reject, { once: true });
          return;
        }

        const script = document.createElement("script");
        script.src = "https://accounts.google.com/gsi/client";
        script.async = true;
        script.defer = true;
        script.onload = () => resolve();
        script.onerror = reject;
        document.head.appendChild(script);
      }).finally(() => {
        scriptPromiseRef.current = null;
      });
    }

    return scriptPromiseRef.current;
  }, []);

  // Lazily create the OAuth token client. We only initialise the client when a
  // consumer actually asks for a token. The client instance is cached in a ref
  // so subsequent callers reuse the same object.
  const ensureTokenClient = useCallback(async () => {
    const { clientId } = googleClientManager.getOAuthClient();
    if (!clientId?.trim()) {
      throw new Error("Google OAuth client is not configured.");
    }
    if (tokenClientRef.current && oauthClientIdRef.current === clientId) {
      return tokenClientRef.current;
    }
    tokenClientRef.current = null;
    oauthClientIdRef.current = clientId;

    await ensureScriptLoaded();

    const oauth = window.google?.accounts?.oauth2;
    if (!oauth?.initTokenClient) {
      throw new Error("Google OAuth client is not available.");
    }

    const client = oauth.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPES.join(" "),
      callback: (response: AccessTokenResponse) => {
        if (!handlersRef.current) {
          return;
        }
        const { resolve, reject } = handlersRef.current;
        handlersRef.current = null;
        if (response.error || !response.access_token) {
          reject(response.error ?? new Error("Failed to obtain access token"));
          return;
        }
        setAccessToken(response.access_token, response.expires_in ?? 3600);
        resolve(response.access_token);
      },
    });

    tokenClientRef.current = client;
    return client;
  }, [ensureScriptLoaded, setAccessToken]);

  // Public entry point: fetch (or reuse) an access token. The callback contains
  // all of the state orchestration so Callers can simply `await`.
  const ensureAccessToken = useCallback(() => {
    const currentInfo = tokenInfoRef.current;
    if (
      currentInfo?.token &&
      currentInfo.expiresAt > Date.now() + REFRESH_MARGIN_MS
    ) {
      return Promise.resolve(currentInfo.token);
    }

    if (pendingPromiseRef.current) {
      return pendingPromiseRef.current;
    }

    pendingPromiseRef.current = (async () => {
      if (callbackPromiseRef.current) {
        await callbackPromiseRef.current;
      }
      if (callbackErrorRef.current) {
        const callbackError = callbackErrorRef.current;
        callbackErrorRef.current = null;
        throw callbackError;
      }

      const refreshedInfo = tokenInfoRef.current;
      if (
        refreshedInfo?.token &&
        refreshedInfo.expiresAt > Date.now() + REFRESH_MARGIN_MS
      ) {
        return refreshedInfo.token;
      }

      const oauthClient = googleClientManager.getOAuthClient();
      if (oauthClient.authFlow === "pkce" || oauthClient.authUxMode === "redirect") {
        await startPkceRedirect();
        throw new Error("Redirecting to Google OAuth for Drive authorization.");
      }

      const client = await ensureTokenClient();
      return await new Promise<string>((resolve, reject) => {
        handlersRef.current = { resolve, reject };
        client.callback = (response: AccessTokenResponse) => {
          if (!handlersRef.current) {
            return;
          }
          const { resolve: pendingResolve, reject: pendingReject } =
            handlersRef.current;
          handlersRef.current = null;

          if (response.error || !response.access_token) {
            pendingReject(
              response.error ?? new Error("Failed to obtain access token"),
            );
            return;
          }
          setAccessToken(response.access_token, response.expires_in ?? 3600);
          pendingResolve(response.access_token);
        };
        try {
          console.log("Requesting access token from Google OAuth");
          client.requestAccessToken({
            prompt: currentInfo?.token ? "" : "consent",
          });
        } catch (error) {
          handlersRef.current = null;
          appLogger.error("Failed to request Google access token", {
            attrs: {
              scope: "storage.drive.auth",
              code: "DRIVE_AUTH_TOKEN_REQUEST_FAILED",
              error: String(error),
            },
          });
          reject(error);
        }
      });
    })().finally(() => {
      pendingPromiseRef.current = null;
    });

    return pendingPromiseRef.current;
  }, [ensureTokenClient, setAccessToken, startPkceRedirect]);

  // useMemo caches the context value so React hands the same object reference to
  // consumers unless one of the dependencies changes. This prevents needless
  // rerenders in deep trees that subscribe to the context.
  const value = useMemo(
    () => ({
      ensureAccessToken,
      setAccessToken,
    }),
    [ensureAccessToken, setAccessToken],
  );

  return (
    <GoogleAuthContext.Provider value={value}>
      {children}
    </GoogleAuthContext.Provider>
  );
}
