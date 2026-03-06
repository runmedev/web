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

  it("stores the ChatKit domain key from app config in local storage", async () => {
    const { applyAppConfig, getConfiguredChatKitDomainKey } = await loadModules();

    const result = applyAppConfig(
      {
        agent: {
          endpoint: "http://localhost:9977",
        },
        chatkit: {
          domainKey: "domain_pk_configured",
        },
      },
      "http://localhost/configs/app-configs.yaml",
    );

    expect(result.warnings).toEqual([]);
    expect(result.chatkitDomainKey).toBe("domain_pk_configured");
    expect(getConfiguredChatKitDomainKey()).toBe("domain_pk_configured");

    const stored = JSON.parse(
      window.localStorage.getItem("cloudAssistantSettings") ?? "{}",
    );
    expect(stored.chatkit).toEqual({
      domainKey: "domain_pk_configured",
    });
  });

  it("falls back to the existing ChatKit localhost default when no config is stored", async () => {
    const { getConfiguredChatKitDomainKey } = await loadModules();

    expect(getConfiguredChatKitDomainKey()).toBe("domain_pk_localhost_dev");
  });

  it("preserves the runtime Google Drive base URL when config omits it", async () => {
    const { applyAppConfig } = await loadModules();
    const { setGoogleDriveBaseUrl, getGoogleDriveBaseUrl } = await import(
      "./googleDriveRuntime"
    );

    setGoogleDriveBaseUrl("http://127.0.0.1:9090");

    applyAppConfig(
      {
        agent: {
          endpoint: "http://localhost:9977",
        },
        googleDrive: {
          clientID: "client-id.apps.googleusercontent.com",
        },
      },
      "http://localhost/configs/app-configs.yaml",
    );

    expect(getGoogleDriveBaseUrl()).toBe("http://127.0.0.1:9090");
  });

  it("applies Google Drive PKCE auth flow when configured", async () => {
    const { applyAppConfig } = await loadModules();
    const { googleClientManager } = await import("./googleClientManager");

    applyAppConfig(
      {
        agent: {
          endpoint: "http://localhost:9977",
        },
        googleDrive: {
          clientID: "client-id.apps.googleusercontent.com",
          authFlow: "pkce",
        },
      },
      "http://localhost/configs/app-configs.yaml",
    );

    expect(googleClientManager.getOAuthClient()).toMatchObject({
      clientId: "client-id.apps.googleusercontent.com",
      authFlow: "pkce",
      authUxMode: "redirect",
    });
    expect(googleClientManager.getDrivePickerConfig().clientId).toBe(
      "client-id.apps.googleusercontent.com",
    );
  });

  it("preserves local Google Drive config when local precedence is requested", async () => {
    const { applyAppConfig } = await loadModules();
    const { googleClientManager } = await import("./googleClientManager");

    googleClientManager.setOAuthClient({
      clientId: "local-client.apps.googleusercontent.com",
      authFlow: "pkce",
      authUxMode: "redirect",
    });

    applyAppConfig(
      {
        agent: {
          endpoint: "http://localhost:9977",
        },
        googleDrive: {
          clientID: "config-client.apps.googleusercontent.com",
          authFlow: "implicit",
        },
      },
      "http://localhost/configs/app-configs.yaml",
      {
        preserveLocalConfiguration: true,
      },
    );

    expect(googleClientManager.getOAuthClient()).toMatchObject({
      clientId: "local-client.apps.googleusercontent.com",
      authFlow: "pkce",
      authUxMode: "redirect",
    });
  });

  it("toggles app-config local precedence on load", async () => {
    const {
      disableAppConfigOverridesOnLoad,
      enableAppConfigOverridesOnLoad,
      isLocalConfigPreferredOnLoad,
      setLocalConfigPreferredOnLoad,
    } = await loadModules();

    expect(isLocalConfigPreferredOnLoad()).toBe(false);

    expect(disableAppConfigOverridesOnLoad()).toBe(true);
    expect(isLocalConfigPreferredOnLoad()).toBe(true);

    expect(setLocalConfigPreferredOnLoad(false)).toBe(false);
    expect(isLocalConfigPreferredOnLoad()).toBe(false);

    expect(enableAppConfigOverridesOnLoad()).toBe(false);
    expect(isLocalConfigPreferredOnLoad()).toBe(false);
  });
});
