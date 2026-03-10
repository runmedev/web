import { describe, expect, it, vi } from "vitest";

const { appLoggerMock } = vi.hoisted(() => ({
  appLoggerMock: {
    info: vi.fn(),
  },
}));

vi.mock("../logging/runtime", () => ({
  appLogger: appLoggerMock,
}));

import {
  extractCodexLogIdentifiers,
  logCodexEvent,
  sanitizeCodexLogPayload,
} from "./codexLogging";

describe("codexLogging", () => {
  it("redacts authorization and session_token fields", () => {
    expect(
      sanitizeCodexLogPayload({
        authorization: "Bearer secret-token",
        url: "http://localhost:5191/mcp/notebooks?session_token=abc123",
      }),
    ).toEqual({
      authorization: "[REDACTED]",
      url: "http://localhost:5191/mcp/notebooks?session_token=%5BREDACTED%5D",
    });
  });

  it("extracts thread, turn, and item identifiers from nested payloads", () => {
    expect(
      extractCodexLogIdentifiers({
        thread: { id: "thread-1" },
        turn: { id: "turn-1" },
        item: { id: "item-1" },
      }),
    ).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
    });
  });

  it("logs sanitized payloads through appLogger", () => {
    appLoggerMock.info.mockClear();
    logCodexEvent("Codex proxy request", {
      scope: "chatkit.codex_proxy",
      direction: "outbound",
      transport: "codex_proxy",
      jsonrpcMethod: "initialize",
      payload: {
        authorization: "Bearer secret-token",
      },
    });

    expect(appLoggerMock.info).toHaveBeenCalledWith(
      "Codex proxy request",
      expect.objectContaining({
        attrs: expect.objectContaining({
          scope: "chatkit.codex_proxy",
          payload: {
            authorization: "[REDACTED]",
          },
        }),
      }),
    );
  });
});
