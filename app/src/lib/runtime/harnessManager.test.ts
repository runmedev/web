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

describe("harnessManager", () => {
  beforeEach(() => {
    localStorage.removeItem(HARNESS_STORAGE_KEY);
    __resetHarnessManagerForTests();
  });

  it("bootstraps a default responses-direct harness with empty baseUrl", () => {
    const mgr = getHarnessManager();
    const active = mgr.getDefault();

    expect(active.name).toBe("local-responses");
    expect(active.adapter).toBe("responses-direct");
    expect(active.baseUrl).toBe("");
    expect(mgr.resolveChatkitUrl(active)).toBe("/responses/direct/chatkit");
  });

  it("uses app.harness updates and default selection", () => {
    const mgr = getHarnessManager();

    mgr.update("alt", "http://127.0.0.1:7788", "responses-direct");
    mgr.setDefault("alt");

    const active = mgr.getDefault();
    expect(active.name).toBe("alt");
    expect(active.baseUrl).toBe("http://127.0.0.1:7788");
    expect(active.adapter).toBe("responses-direct");
    expect(mgr.resolveChatkitUrl(active)).toBe("http://127.0.0.1:7788/responses/direct/chatkit");
  });

  it("builds codex route for codex harnesses", () => {
    expect(buildChatkitUrl("http://localhost:1234", "codex")).toBe(
      "http://localhost:1234/codex/chatkit",
    );
  });

  it("builds codex-wasm route for local codex wasm harnesses", () => {
    expect(buildChatkitUrl("http://localhost:1234", "codex-wasm")).toBe(
      "http://localhost:1234/codex/wasm/chatkit",
    );
    expect(buildChatkitUrl("", "codex-wasm")).toBe("/codex/wasm/chatkit");
  });

  it("builds responses-direct route for direct OpenAI harnesses", () => {
    expect(buildChatkitUrl("http://localhost:1234", "responses-direct")).toBe(
      "http://localhost:1234/responses/direct/chatkit",
    );
    expect(buildChatkitUrl("", "responses-direct")).toBe("/responses/direct/chatkit");
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

  it("migrates stored responses harness adapters to responses-direct", () => {
    localStorage.setItem(
      HARNESS_STORAGE_KEY,
      JSON.stringify({
        harnesses: [
          { name: "legacy", baseUrl: "http://127.0.0.1:9090", adapter: "responses" },
        ],
        defaultHarnessName: "legacy",
      }),
    );
    __resetHarnessManagerForTests();

    const mgr = getHarnessManager();
    const active = mgr.getDefault();
    expect(active.name).toBe("legacy");
    expect(active.baseUrl).toBe("");
    expect(active.adapter).toBe("responses-direct");
    expect(mgr.resolveChatkitUrl(active)).toBe("/responses/direct/chatkit");
  });

  it("allows empty baseUrl for responses-direct adapter", () => {
    const mgr = getHarnessManager();
    mgr.update("openai-default", "", "responses-direct");
    mgr.setDefault("openai-default");

    const active = mgr.getDefault();
    expect(active.name).toBe("openai-default");
    expect(active.baseUrl).toBe("");
    expect(active.adapter).toBe("responses-direct");
  });

  it("allows empty baseUrl for codex-wasm adapter", () => {
    const mgr = getHarnessManager();
    mgr.update("local-codex-wasm", "", "codex-wasm");
    mgr.setDefault("local-codex-wasm");

    const active = mgr.getDefault();
    expect(active.name).toBe("local-codex-wasm");
    expect(active.baseUrl).toBe("");
    expect(active.adapter).toBe("codex-wasm");
    expect(mgr.resolveChatkitUrl(active)).toBe("/codex/wasm/chatkit");
  });

  it("rejects empty baseUrl for codex adapter", () => {
    const mgr = getHarnessManager();
    expect(() => mgr.update("codex-local", "", "codex")).toThrow(
      "Harness baseUrl is required for codex adapter",
    );
  });

  it("syncs harness updates from storage events", () => {
    const mgr = getHarnessManager();

    localStorage.setItem(
      HARNESS_STORAGE_KEY,
      JSON.stringify({
        harnesses: [
          { name: "external-codex", baseUrl: "http://127.0.0.1:9999", adapter: "codex" },
        ],
        defaultHarnessName: "external-codex",
      }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: HARNESS_STORAGE_KEY,
        newValue: localStorage.getItem(HARNESS_STORAGE_KEY),
      }),
    );

    const active = mgr.getDefault();
    expect(active.name).toBe("external-codex");
    expect(active.adapter).toBe("codex");
    expect(active.baseUrl).toBe("http://127.0.0.1:9999");
  });

  it("syncs harness updates from same-window change events", () => {
    const mgr = getHarnessManager();

    localStorage.setItem(
      HARNESS_STORAGE_KEY,
      JSON.stringify({
        harnesses: [
          { name: "same-window-codex", baseUrl: "http://127.0.0.1:7777", adapter: "codex" },
        ],
        defaultHarnessName: "same-window-codex",
      }),
    );
    window.dispatchEvent(new CustomEvent("runme:harness-changed"));

    const active = mgr.getDefault();
    expect(active.name).toBe("same-window-codex");
    expect(active.adapter).toBe("codex");
    expect(active.baseUrl).toBe("http://127.0.0.1:7777");
  });
});
