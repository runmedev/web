import { useEffect, useState } from "react";
import { OaiAuthBrowserAdapter } from "@oai/auth-sdk-browser-adapter";

// This must be awaited in the client app initialization code
// (can't do it below because top-level await fails in our build)
const browserAdapter: OaiAuthBrowserAdapter = new OaiAuthBrowserAdapter({
  baseUrl: import.meta.env.VITE_AUTHAPI_BASE_URL,
  clientId: import.meta.env.VITE_OAUTH_CLIENT_ID,
  // Use the current window location as the redirect URI since we do the callback in the browser.
  redirectUri: new URL("/oidc/callback", window.location.origin).toString(),
  scope: import.meta.env.VITE_OAUTH_SCOPE,
  iAcknowledgeThisLibIsNotReadyForProd: true,
});

export function getBrowserAdapter(): OaiAuthBrowserAdapter {
  return browserAdapter;
}

/**
 * A simple hook that can be used to get the current auth data. Stays up to data as the
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
