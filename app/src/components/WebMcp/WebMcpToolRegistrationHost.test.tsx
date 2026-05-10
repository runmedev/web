// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const { executeMock, appConsoleDataMock, appLoggerMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  appConsoleDataMock: {
    hydrate: vi.fn(),
    startExternalExecution: vi.fn(),
    appendStdout: vi.fn(),
    appendStderr: vi.fn(),
    completeExecution: vi.fn(),
    failExecution: vi.fn(),
  },
  appLoggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../lib/runtime/useCodeModeExecutor", () => ({
  useCodeModeExecutor: () => ({
    execute: executeMock,
  }),
}));

vi.mock("../../lib/appConsole/appConsoleController", () => ({
  getAppConsoleData: () => appConsoleDataMock,
}));

vi.mock("../../lib/logging/runtime", () => ({
  appLogger: appLoggerMock,
}));

import WebMcpToolRegistrationHost from "./WebMcpToolRegistrationHost";

describe("WebMcpToolRegistrationHost", () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue({ output: "webmcp output" });
    appConsoleDataMock.hydrate.mockReset();
    appConsoleDataMock.hydrate.mockResolvedValue(undefined);
    appConsoleDataMock.startExternalExecution.mockReset();
    appConsoleDataMock.startExternalExecution.mockReturnValue({
      cellId: "cell-1",
      source: "console.log('hello')",
    });
    appConsoleDataMock.appendStdout.mockReset();
    appConsoleDataMock.appendStderr.mockReset();
    appConsoleDataMock.completeExecution.mockReset();
    appConsoleDataMock.failExecution.mockReset();
    appLoggerMock.debug.mockReset();
    appLoggerMock.info.mockReset();
    appLoggerMock.error.mockReset();
    delete (navigator as Navigator & { modelContext?: unknown }).modelContext;
  });

  afterEach(() => {
    cleanup();
    delete (navigator as Navigator & { modelContext?: unknown }).modelContext;
  });

  it("skips registration when navigator.modelContext is unavailable", () => {
    render(<WebMcpToolRegistrationHost />);

    expect(appLoggerMock.debug).toHaveBeenCalledWith(
      "WebMCP unavailable; skipping tool registration",
      expect.objectContaining({
        attrs: expect.objectContaining({
          scope: "webmcp",
        }),
      }),
    );
  });

  it("registers ExecuteCode and unregisters it on cleanup", async () => {
    let registered:
      | {
          tool: {
            name: string;
            title: string;
            description: string;
            inputSchema: Record<string, unknown>;
            annotations: {
              readOnlyHint: boolean;
              untrustedContentHint: boolean;
            };
            execute: (input: { code?: unknown }) => Promise<string>;
          };
          signal?: AbortSignal;
        }
      | undefined;
    const registerTool = vi.fn((tool, options?: { signal?: AbortSignal }) => {
      registered = {
        tool,
        signal: options?.signal,
      };
    });
    Object.defineProperty(navigator, "modelContext", {
      configurable: true,
      value: {
        registerTool,
      },
    });

    const rendered = render(<WebMcpToolRegistrationHost />);

    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registered?.tool.name).toBe("ExecuteCode");
    expect(registered?.tool.title).toBe("Runme Execute Code");
    expect(registered?.tool.annotations).toEqual({
      readOnlyHint: false,
      untrustedContentHint: true,
    });
    expect(registered?.tool.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        code: { type: "string" },
      },
      required: ["code"],
    });

    await expect(
      registered?.tool.execute({
        code: "console.log('hello')",
      }),
    ).resolves.toBe("webmcp output");
    expect(appConsoleDataMock.hydrate).toHaveBeenCalledTimes(1);
    expect(appConsoleDataMock.startExternalExecution).toHaveBeenCalledWith(
      "console.log('hello')",
    );
    expect(executeMock).toHaveBeenCalledWith({
      code: "console.log('hello')",
      source: "webmcp",
      hooks: {
        onStdout: expect.any(Function),
        onStderr: expect.any(Function),
      },
    });
    const executeArgs = executeMock.mock.calls[0]?.[0];
    executeArgs?.hooks?.onStdout?.("stdout chunk");
    executeArgs?.hooks?.onStderr?.("stderr chunk");
    expect(appConsoleDataMock.appendStdout).toHaveBeenCalledWith(
      "cell-1",
      "stdout chunk",
    );
    expect(appConsoleDataMock.appendStderr).toHaveBeenCalledWith(
      "cell-1",
      "stderr chunk",
    );
    expect(appConsoleDataMock.completeExecution).toHaveBeenCalledWith("cell-1", {
      exitCode: 0,
    });
    expect(appConsoleDataMock.failExecution).not.toHaveBeenCalled();

    expect(registered?.signal?.aborted).toBe(false);
    rendered.unmount();
    expect(registered?.signal?.aborted).toBe(true);
  });

  it("marks the AppConsole cell failed when ExecuteCode rejects", async () => {
    executeMock.mockRejectedValueOnce(new Error("boom"));
    Object.defineProperty(navigator, "modelContext", {
      configurable: true,
      value: {
        registerTool: vi.fn(),
      },
    });

    render(<WebMcpToolRegistrationHost />);
    const registerTool = (navigator as Navigator & {
      modelContext?: { registerTool: ReturnType<typeof vi.fn> };
    }).modelContext?.registerTool;
    const registered = registerTool?.mock.calls[0]?.[0];

    await expect(
      registered?.execute({
        code: "console.log('hello')",
      }),
    ).rejects.toThrow("boom");

    expect(appConsoleDataMock.failExecution).toHaveBeenCalledWith("cell-1", {
      message: "boom",
    });
  });
});
