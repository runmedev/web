import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadModules() {
  vi.resetModules();
  const appConfig = await import("./appConfig");
  const oidcConfig = await import("../auth/oidcConfig");
  return {
    ...appConfig,
    ...oidcConfig,
  };
}

describe("appConfig OIDC Google shorthand", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/index.html");
  });

  it("applies Google defaults when oidc.google is configured", async () => {
    const { applyAppConfig } = await loadModules();

    const result = applyAppConfig(
      {
        agent: {
          endpoint: "http://localhost:9977",
        },
        oidc: {
          google: {
            clientID: "client-id.apps.googleusercontent.com",
          },
        },
      },
      "http://localhost/configs/app-configs.yaml",
    );

    expect(result.warnings).toEqual([]);
    expect(result.oidc).toMatchObject({
      discoveryUrl:
        "https://accounts.google.com/.well-known/openid-configuration",
      clientId: "client-id.apps.googleusercontent.com",
      scope: "openid https://www.googleapis.com/auth/userinfo.email",
      extraAuthParams: {
        access_type: "offline",
        prompt: "consent",
      },
    });
    expect(result.oidc?.redirectUri).toMatch(
      /^http:\/\/localhost(:\d+)?\/oidc\/callback$/,
    );
  });

  it("allows setGoogleDefaults before the client ID is set", async () => {
    const { oidcConfigManager } = await loadModules();

    expect(() => oidcConfigManager.setGoogleDefaults()).not.toThrow();

    const config = oidcConfigManager.setClientId(
      "client-id.apps.googleusercontent.com",
    );

    expect(config.discoveryUrl).toBe(
      "https://accounts.google.com/.well-known/openid-configuration",
    );
    expect(config.scope).toBe(
      "openid https://www.googleapis.com/auth/userinfo.email",
    );
    expect(config.clientId).toBe("client-id.apps.googleusercontent.com");
    expect(config.extraAuthParams).toEqual({
      access_type: "offline",
      prompt: "consent",
    });
  });
});
