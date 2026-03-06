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

  it("applies direct Responses OpenAI config from agent.openai", async () => {
    const { applyAppConfig } = await loadModules();

    const result = applyAppConfig(
      {
        agent: {
          endpoint: "http://localhost:9977",
          openai: {
            authMethod: "OAuth",
            organization: "org-test",
            project: "proj-test",
            vectorStores: ["vs_1", "vs_2"],
          },
        },
      },
      "http://localhost/configs/app-configs.yaml",
    );

    expect(result.warnings).toEqual([]);
    expect(result.responsesDirect).toEqual({
      authMethod: "oauth",
      openaiOrganization: "org-test",
      openaiProject: "proj-test",
      vectorStores: ["vs_1", "vs_2"],
      apiKeySet: false,
    });
  });

  it("supports go-style top-level OpenAI and cloudAssistant vectorStores", async () => {
    const { applyAppConfig } = await loadModules();

    const result = applyAppConfig(
      {
        agent: {
          endpoint: "http://localhost:9977",
        },
        openai: {
          authMethod: "OAuth",
          organization: "org-top-level",
          project: "proj-top-level",
        },
        cloudAssistant: {
          vectorStores: ["vs_top"],
        },
      },
      "http://localhost/configs/app-configs.yaml",
    );

    expect(result.warnings).toEqual([]);
    expect(result.responsesDirect).toEqual({
      authMethod: "oauth",
      openaiOrganization: "org-top-level",
      openaiProject: "proj-top-level",
      vectorStores: ["vs_top"],
      apiKeySet: false,
    });
  });

  it("warns when direct Responses is configured for API key auth without a key", async () => {
    const { applyAppConfig } = await loadModules();

    const result = applyAppConfig(
      {
        agent: {
          endpoint: "http://localhost:9977",
          openai: {
            authMethod: "APIKey",
          },
        },
      },
      "http://localhost/configs/app-configs.yaml",
    );

    expect(result.responsesDirect?.authMethod).toBe("api_key");
    expect(result.warnings).toContain(
      "Direct Responses API key auth selected; set API key via app.responsesDirect.setAPIKey(...)",
    );
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

  it("uses joined googleDrive clientMaterial as clientSecret when provided", async () => {
    const { applyAppConfig } = await loadModules();
    const { googleClientManager } = await import("./googleClientManager");

    applyAppConfig(
      {
        agent: {
          endpoint: "http://localhost:9977",
        },
        googleDrive: {
          clientID: "client-id.apps.googleusercontent.com",
          clientSecret: "ignored-client-secret",
          clientMaterial: ["GOCSPX-3N-", "FPEy4XWoKz", "cVwSyt3yDz_Xwzo"],
        },
      },
      "http://localhost/configs/app-configs.yaml",
    );

    expect(googleClientManager.getOAuthClient()).toMatchObject({
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "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",
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
