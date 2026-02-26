// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetHarnessManagerForTests,
  buildCodexAppServerWsUrl,
  buildCodexBridgeWsUrl,
  buildChatkitUrl,
  getHarnessManager,
} from "./harnessManager";

const HARNESS_STORAGE_KEY = "runme/harness";
const LEGACY_SETTINGS_STORAGE_KEY = "cloudAssistantSettings";

describe("harnessManager", () => {
  beforeEach(() => {
    localStorage.removeItem(HARNESS_STORAGE_KEY);
    localStorage.removeItem(LEGACY_SETTINGS_STORAGE_KEY);
    __resetHarnessManagerForTests();
  });

  it("bootstraps a default responses harness from window.location.origin", () => {
    const mgr = getHarnessManager();
    const active = mgr.getDefault();

    expect(active.name).toBe("local-responses");
    expect(active.adapter).toBe("responses");
    expect(active.baseUrl).toBe(window.location.origin);
    expect(mgr.resolveChatkitUrl(active)).toBe(
      new URL("/chatkit", window.location.origin).toString(),
    );
  });

  it("uses app.harness updates and default selection", () => {
    const mgr = getHarnessManager();

    mgr.update("alt", "http://127.0.0.1:7788", "responses");
    mgr.setDefault("alt");

    const active = mgr.getDefault();
    expect(active.name).toBe("alt");
    expect(active.baseUrl).toBe("http://127.0.0.1:7788");
    expect(active.adapter).toBe("responses");
    expect(mgr.resolveChatkitUrl(active)).toBe("http://127.0.0.1:7788/chatkit");
  });

  it("builds codex route for codex harnesses", () => {
    expect(buildChatkitUrl("http://localhost:1234", "codex")).toBe(
      "http://localhost:1234/codex/app-server/ws",
    );
  });

  it("builds codex websocket bridge URL", () => {
    expect(buildCodexBridgeWsUrl("http://localhost:1234")).toBe(
      "ws://localhost:1234/codex/ws",
    );
    expect(buildCodexBridgeWsUrl("https://example.com/base")).toBe(
      "wss://example.com/codex/ws",
    );
    expect(buildCodexBridgeWsUrl("http://localhost:1234", { forceReplace: true })).toBe(
      "ws://localhost:1234/codex/ws?force_replace=true",
    );
  });

  it("builds codex app-server websocket URL", () => {
    expect(buildCodexAppServerWsUrl("http://localhost:1234")).toBe(
      "ws://localhost:1234/codex/app-server/ws",
    );
    expect(buildCodexAppServerWsUrl("https://example.com/base")).toBe(
      "wss://example.com/codex/app-server/ws",
    );
  });

  it("migrates initial endpoint from legacy cloudAssistantSettings when present", () => {
    localStorage.setItem(
      LEGACY_SETTINGS_STORAGE_KEY,
      JSON.stringify({ agentEndpoint: "http://legacy.example:9000" }),
    );
    __resetHarnessManagerForTests();

    const mgr = getHarnessManager();
    const active = mgr.getDefault();
    expect(active.baseUrl).toBe("http://legacy.example:9000");
    expect(active.adapter).toBe("responses");
  });
});
