import { jwtDecode } from "jwt-decode";

import { getBrowserAdapter } from "./browserAdapter.client";

const ID_TOKEN_EXP_SKEW_SECONDS = 60;

type JwtWithExp = {
  exp?: number;
};

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

  const authData = browserAdapter.simpleAuth;
  const idTokenExpiring =
    authData?.idToken !== undefined &&
    willIdTokenExpireSoon(authData.idToken);
  if (authData && (authData.willExpireSoon() || idTokenExpiring)) {
    await browserAdapter.refresh();
  }
  return browserAdapter.simpleAuth;
}

// Returns the value of the session token cookie, or undefined if not found
export function getSessionToken(): string | undefined {
  const authData = getBrowserAdapter().simpleAuth;
  return authData?.idToken ?? undefined;
}

function willIdTokenExpireSoon(token: string): boolean {
  try {
    const decoded = jwtDecode<JwtWithExp>(token);
    if (!decoded.exp) {
      return false;
    }
    const expiresAtMs = decoded.exp * 1000;
    return Date.now() >= expiresAtMs - ID_TOKEN_EXP_SKEW_SECONDS * 1000;
  } catch (error) {
    console.error("Failed to decode id token", error);
    return false;
  }
}
