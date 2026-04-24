import { beforeEach, describe, expect, it, vi } from "vitest";

const { appLoggerMock, getCodexWasmAssetUrlsMock } = vi.hoisted(() => ({
  appLoggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  getCodexWasmAssetUrlsMock: vi.fn(() => ({
    moduleUrl: "/generated/codex.js",
    wasmUrl: "/generated/codex.wasm",
  })),
}));

vi.mock("../logging/runtime", () => ({
  appLogger: appLoggerMock,
}));

vi.mock("./codexWasmHarnessLoader", async () => {
  const actual = await vi.importActual<typeof import("./codexWasmHarnessLoader")>(
    "./codexWasmHarnessLoader",
  );
  return {
    ...actual,
    getCodexWasmAssetUrls: getCodexWasmAssetUrlsMock,
  };
});

import { createCodexWasmAppServerClientForTests } from "./codexWasmAppServerClient";

describe("CodexWasmAppServerClient", () => {
  beforeEach(() => {
    appLoggerMock.info.mockClear();
    appLoggerMock.warn.mockClear();
    appLoggerMock.error.mockClear();
    getCodexWasmAssetUrlsMock.mockClear();
  });

  it("connects the worker with the provided session options", async () => {
    const workerClient = {
      subscribeNotifications: vi.fn(() => () => {}),
      setCodeExecutor: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      request: vi.fn(),
      getEventJournal: vi.fn(),
    };

    const client = createCodexWasmAppServerClientForTests({
      workerClient: workerClient as never,
    });

    await client.connect({
      apiKey: "sk-test",
      sessionOptions: {
        instructions: {
          developer: "developer instructions",
        },
      },
    });

    expect(workerClient.connect).toHaveBeenCalledTimes(1);
    expect(workerClient.connect).toHaveBeenCalledWith({
      apiKey: "sk-test",
      moduleUrl: "/generated/codex.js",
      wasmUrl: "/generated/codex.wasm",
      sessionOptions: {
        instructions: {
          developer: "developer instructions",
        },
      },
    });
    expect(client.getSnapshot()).toMatchObject({
      state: "open",
      lastError: null,
    });
    expect(appLoggerMock.warn).not.toHaveBeenCalled();
  });

  it("surfaces connect failures without retrying", async () => {
    const workerClient = {
      subscribeNotifications: vi.fn(() => () => {}),
      setCodeExecutor: vi.fn(),
      connect: vi.fn().mockRejectedValue(new Error("network failed")),
      shutdown: vi.fn().mockResolvedValue(undefined),
      request: vi.fn(),
      getEventJournal: vi.fn(),
    };

    const client = createCodexWasmAppServerClientForTests({
      workerClient: workerClient as never,
    });

    await expect(
      client.connect({
        apiKey: "sk-test",
        sessionOptions: {
          instructions: {
            developer: "developer instructions",
          },
        },
      }),
    ).rejects.toThrow("network failed");

    expect(workerClient.connect).toHaveBeenCalledTimes(1);
    expect(workerClient.shutdown).not.toHaveBeenCalled();
    expect(client.getSnapshot()).toMatchObject({
      state: "error",
      lastError: "Error: network failed",
    });
  });
});
