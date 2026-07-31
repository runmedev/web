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
    executeMock.mockResolvedValue({ output: "webmcp output", exitCode: 0 });
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

  it("registers WebMCP tools and unregisters them on cleanup", async () => {
    const registered: Array<{
      tool: {
        name: string;
        title: string;
        description: string;
        inputSchema: Record<string, unknown>;
        annotations: {
          readOnlyHint: boolean;
          untrustedContentHint: boolean;
        };
        execute: (input: Record<string, unknown>) => Promise<string> | string;
      };
      signal?: AbortSignal;
    }> = [];
    const registerTool = vi.fn((tool, options?: { signal?: AbortSignal }) => {
      registered.push({
        tool,
        signal: options?.signal,
      });
    });
    Object.defineProperty(navigator, "modelContext", {
      configurable: true,
      value: {
        registerTool,
      },
    });

    const rendered = render(<WebMcpToolRegistrationHost />);

    expect(registerTool).toHaveBeenCalledTimes(6);
    const executeCode = registered.find(
      ({ tool }) => tool.name === "ExecuteCode",
    );
    expect(executeCode?.tool.title).toBe("Runme Execute Code");
    expect(executeCode?.tool.annotations).toEqual({
      readOnlyHint: false,
      untrustedContentHint: true,
    });
    expect(executeCode?.tool.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        code: { type: "string" },
        timeoutMs: {
          type: "integer",
          minimum: 1_000,
          maximum: 60_000,
          description:
            "Optional execution timeout in milliseconds. Defaults to 15000 and is capped at 60000.",
        },
      },
      required: ["code"],
    });

    await expect(
      executeCode?.tool.execute({
        code: "console.log('hello')",
        timeoutMs: 30_000,
      }),
    ).resolves.toBe("webmcp output");
    expect(appConsoleDataMock.hydrate).toHaveBeenCalledTimes(1);
    expect(appConsoleDataMock.startExternalExecution).toHaveBeenCalledWith(
      "console.log('hello')",
    );
    expect(executeMock).toHaveBeenCalledWith({
      code: "console.log('hello')",
      source: "webmcp",
      timeoutMs: 30_000,
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
    expect(appConsoleDataMock.completeExecution).toHaveBeenCalledWith(
      "cell-1",
      {
        exitCode: 0,
      },
    );
    expect(appConsoleDataMock.failExecution).not.toHaveBeenCalled();

    const instructions = registered.find(
      ({ tool }) => tool.name === "readInstructionsForAIAgents",
    );
    expect(instructions?.tool.title).toBe(
      "Read Runme Instructions for AI Agents",
    );
    expect(instructions?.tool.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: false,
    });
    expect(instructions?.tool.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {},
    });
    expect(instructions?.tool.execute({})).toContain(window.location.origin);
    expect(instructions?.tool.execute({})).toContain(
      "await app.getSessionID()",
    );

    const listDocumentation = registered.find(
      ({ tool }) => tool.name === "listDocumentation",
    );
    expect(listDocumentation?.tool.title).toBe("List Runme Documentation");
    expect(listDocumentation?.tool.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: false,
    });
    expect(listDocumentation?.tool.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {},
    });
    expect(JSON.parse(String(listDocumentation?.tool.execute({})))[0]).toEqual(
      expect.objectContaining({
        name: "getting-started",
        description: expect.any(String),
      }),
    );

    const getDocumentation = registered.find(
      ({ tool }) => tool.name === "getDocumentation",
    );
    expect(getDocumentation?.tool.title).toBe("Get Runme Documentation");
    expect(getDocumentation?.tool.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: false,
    });
    expect(getDocumentation?.tool.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    });
    await expect(getDocumentation?.tool.execute({})).rejects.toThrow(
      "non-empty name returned by listDocumentation",
    );

    const showTourStep = registered.find(
      ({ tool }) => tool.name === "showTourStep",
    );
    expect(showTourStep?.tool.annotations).toEqual({
      readOnlyHint: false,
      untrustedContentHint: false,
    });
    expect(
      JSON.parse(
        String(
          showTourStep?.tool.execute({
            target: "left-nav.google-drive",
            message: "Click here to connect Google Drive.",
          }),
        ),
      ),
    ).toMatchObject({
      target: "left-nav.google-drive",
      message: "Click here to connect Google Drive.",
    });

    const dismissTour = registered.find(
      ({ tool }) => tool.name === "dismissTour",
    );
    expect(JSON.parse(String(dismissTour?.tool.execute({})))).toEqual({
      dismissed: true,
    });

    expect(registered.every(({ signal }) => signal?.aborted === false)).toBe(
      true,
    );
    rendered.unmount();
    expect(registered.every(({ signal }) => signal?.aborted === true)).toBe(
      true,
    );
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
    const registerTool = (
      navigator as Navigator & {
        modelContext?: { registerTool: ReturnType<typeof vi.fn> };
      }
    ).modelContext?.registerTool;
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

  it("uses the resolved ExecuteCode exit code when finalizing the AppConsole cell", async () => {
    executeMock.mockResolvedValueOnce({
      output: "runtime error output",
      exitCode: 1,
    });
    Object.defineProperty(navigator, "modelContext", {
      configurable: true,
      value: {
        registerTool: vi.fn(),
      },
    });

    render(<WebMcpToolRegistrationHost />);
    const registerTool = (
      navigator as Navigator & {
        modelContext?: { registerTool: ReturnType<typeof vi.fn> };
      }
    ).modelContext?.registerTool;
    const registered = registerTool?.mock.calls[0]?.[0];

    await expect(
      registered?.execute({
        code: "throw new Error('boom')",
      }),
    ).resolves.toBe("runtime error output");

    expect(appConsoleDataMock.completeExecution).toHaveBeenCalledWith(
      "cell-1",
      {
        exitCode: 1,
      },
    );
    expect(appConsoleDataMock.failExecution).not.toHaveBeenCalled();
  });
});
