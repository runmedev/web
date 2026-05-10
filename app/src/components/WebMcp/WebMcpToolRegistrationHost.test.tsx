// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const { executeMock, appLoggerMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
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

vi.mock("../../lib/logging/runtime", () => ({
  appLogger: appLoggerMock,
}));

import WebMcpToolRegistrationHost from "./WebMcpToolRegistrationHost";

describe("WebMcpToolRegistrationHost", () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue({ output: "webmcp output" });
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
    expect(executeMock).toHaveBeenCalledWith({
      code: "console.log('hello')",
      source: "webmcp",
    });

    expect(registered?.signal?.aborted).toBe(false);
    rendered.unmount();
    expect(registered?.signal?.aborted).toBe(true);
  });
});
