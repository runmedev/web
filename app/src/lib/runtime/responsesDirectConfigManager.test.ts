// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetResponsesDirectConfigManagerForTests,
} from "./responsesDirectConfigManager";

describe("responsesDirectConfigManager", () => {
  beforeEach(async () => {
    localStorage.removeItem("runme/responses-direct-config");
    __resetResponsesDirectConfigManagerForTests();
    const { responsesDirectConfigManager: manager } = await import(
      "./responsesDirectConfigManager"
    );
    manager.setAuthMethod("oauth");
    manager.setOpenAIOrganization("");
    manager.setOpenAIProject("");
    manager.setVectorStores([]);
    manager.clearAPIKey();
  });

  it("defaults to oauth with empty project/org and api key", async () => {
    const { responsesDirectConfigManager: manager } = await import(
      "./responsesDirectConfigManager"
    );
    const snapshot = manager.getSnapshot();
    expect(snapshot.authMethod).toBe("oauth");
    expect(snapshot.openaiOrganization).toBe("");
    expect(snapshot.openaiProject).toBe("");
    expect(snapshot.vectorStores).toEqual([]);
    expect(snapshot.apiKey).toBe("");
  });

  it("persists api key and auth method changes", async () => {
    const { responsesDirectConfigManager: manager } = await import(
      "./responsesDirectConfigManager"
    );
    manager.setAuthMethod("apiKey");
    manager.setAPIKey("sk-test");

    const raw = localStorage.getItem("runme/responses-direct-config");
    expect(raw).toBeTruthy();

    __resetResponsesDirectConfigManagerForTests();
    const reloaded = (await import("./responsesDirectConfigManager"))
      .responsesDirectConfigManager;
    const snapshot = reloaded.getSnapshot();
    expect(snapshot.authMethod).toBe("api_key");
    expect(snapshot.apiKey).toBe("sk-test");
  });

  it("applies defaults from app config without overriding explicit API key", async () => {
    const { responsesDirectConfigManager: manager } = await import(
      "./responsesDirectConfigManager"
    );
    manager.setAPIKey("sk-user");
    manager.applyDefaults({
      authMethod: "OAuth",
      openaiOrganization: "org-config",
      openaiProject: "proj-config",
      vectorStores: ["vs_1", "vs_2"],
    });

    const snapshot = manager.getSnapshot();
    expect(snapshot.authMethod).toBe("oauth");
    expect(snapshot.openaiOrganization).toBe("org-config");
    expect(snapshot.openaiProject).toBe("proj-config");
    expect(snapshot.vectorStores).toEqual(["vs_1", "vs_2"]);
    expect(snapshot.apiKey).toBe("sk-user");
  });
});
