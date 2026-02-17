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
import { googleClientManager } from "../lib/googleClientManager";

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
  error?: string;
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

  useEffect(() => {
    tokenInfoRef.current = tokenInfo;
  }, [tokenInfo]);

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
          reject(error);
        }
      });
    })().finally(() => {
      pendingPromiseRef.current = null;
    });

    return pendingPromiseRef.current;
  }, [ensureTokenClient, setAccessToken]);

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
