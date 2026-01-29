import { getBrowserAdapter } from "./browserAdapter.client";

// Returns the value of the oauth access token.
export async function getAccessToken(): Promise<string> {
  const authData = await getAuthData();
  const token = authData?.accessToken || "";
  if (token === "") {
    console.log(
      "Error no OpenAI access token found in browser adapter; AI requests will fail.",
    );
  }
  return token;
}

// getAuthData is a simple wrapper to refresh data if necessary.
export async function getAuthData() {
  const browserAdapter = getBrowserAdapter();

  if (browserAdapter.simpleAuth && browserAdapter.simpleAuth.willExpireSoon()) {
    await browserAdapter.refresh();
  }
  return browserAdapter.simpleAuth;
}

// Returns the value of the session token cookie, or undefined if not found
export function getSessionToken(): string | undefined {
  // TODO(jlewi): This function is called from SettingsContext.
  // It was inherited as part of the Runme fork; we could probably clean things up.
  // const authData = await getAuthData();
  // const idToken = authData?.idToken ?? undefined;
  // return idToken;
  return undefined;
}
