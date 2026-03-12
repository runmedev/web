// @vitest-environment jsdom
import { useEffect } from "react";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { googleClientManager } from "../lib/googleClientManager";
import { GoogleAuthProvider, useGoogleAuth } from "./GoogleAuthContext";

const PKCE_STATE_KEY = "runme/google-auth/pkce-state";
const PKCE_CODE_VERIFIER_KEY = "runme/google-auth/pkce-code-verifier";
const PKCE_RETURN_TO_KEY = "runme/google-auth/pkce-return-to";
const IMPLICIT_PROMPT_MODE_KEY = "runme/google-auth/implicit-prompt-mode";

function CaptureAuth(props: {
  onReady: (auth: ReturnType<typeof useGoogleAuth>) => void;
}) {
  const { onReady } = props;
  const auth = useGoogleAuth();
  useEffect(() => {
    onReady(auth);
  }, [auth, onReady]);
  return null;
}

async function renderWithGoogleAuthProvider() {
  let captured: ReturnType<typeof useGoogleAuth> | null = null;
  render(
    <GoogleAuthProvider>
      <CaptureAuth
        onReady={(auth) => {
          captured = auth;
        }}
      />
    </GoogleAuthProvider>,
  );
  await waitFor(() => {
    expect(captured).not.toBeNull();
  });
  return captured!;
}

describe("GoogleAuthProvider implicit redirect flow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
    googleClientManager.setOAuthClient({
      clientId: "test-client.apps.googleusercontent.com",
      authFlow: "implicit",
      authUxMode: "popup",
    });
  });

  it("starts implicit redirect flow when authFlow=implicit and authUxMode=redirect", async () => {
    googleClientManager.setOAuthClient({
      authFlow: "implicit",
      authUxMode: "redirect",
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = await renderWithGoogleAuthProvider();

    await expect(auth.ensureAccessToken()).rejects.toThrow();

    expect(window.localStorage.getItem(PKCE_STATE_KEY)).toBeTruthy();
    expect(window.localStorage.getItem(PKCE_RETURN_TO_KEY)).toBe("/");
    expect(window.localStorage.getItem(IMPLICIT_PROMPT_MODE_KEY)).toBe("none");
    // Implicit redirect should not mint a PKCE verifier.
    expect(window.localStorage.getItem(PKCE_CODE_VERIFIER_KEY)).toBeNull();
  });

});
