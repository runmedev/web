import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCodexToolBridgeForTests,
  type WebSocketFactory,
} from "./codexToolBridge";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(public readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({} as CloseEvent);
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({} as Event);
  }

  emitMessage(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  emitClose(event?: Partial<CloseEvent>): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "", ...event } as CloseEvent);
  }
}

describe("CodexToolBridge", () => {
  let sockets: FakeWebSocket[];
  let wsFactory: WebSocketFactory;

  beforeEach(() => {
    sockets = [];
    // Patch static constants used by the runtime.
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = {
      OPEN: FakeWebSocket.OPEN,
    } as typeof WebSocket;
    wsFactory = (url: string) => {
      const ws = new FakeWebSocket(url);
      sockets.push(ws);
      return ws as unknown as WebSocket;
    };
  });

  it("connects and reports open state", () => {
    const bridge = createCodexToolBridgeForTests({ wsFactory });

    bridge.connect("ws://localhost:1234/codex/ws");
    expect(sockets).toHaveLength(1);
    expect(bridge.getSnapshot().state).toBe("connecting");

    sockets[0]?.emitOpen();
    expect(bridge.getSnapshot().state).toBe("open");
  });

  it("handles a tool-call request and sends response envelope", async () => {
    const bridge = createCodexToolBridgeForTests({ wsFactory });
    const handler = vi.fn(async ({ bridgeCallId, toolCallInput }) => ({
      ok: true,
      bridgeCallId,
      echoed: toolCallInput,
    }));

    bridge.setHandler(handler);
    bridge.connect("ws://localhost:1234/codex/ws");
    sockets[0]?.emitOpen();

    sockets[0]?.emitMessage(JSON.stringify({
      type: "NotebookToolCallRequest",
      bridge_call_id: "bridge_1",
      tool_call_input: { call_id: "call_1" },
    }));

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler).toHaveBeenCalledWith({
      bridgeCallId: "bridge_1",
      toolCallInput: { call_id: "call_1" },
    });
    const sent = sockets[0]?.sent ?? [];
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0] ?? "{}")).toEqual({
      type: "NotebookToolCallResponse",
      bridge_call_id: "bridge_1",
      tool_call_output: {
        ok: true,
        bridgeCallId: "bridge_1",
        echoed: { call_id: "call_1" },
      },
    });
  });

  it("records error on malformed JSON", () => {
    const bridge = createCodexToolBridgeForTests({ wsFactory });
    bridge.connect("ws://localhost:1234/codex/ws");
    sockets[0]?.emitOpen();

    sockets[0]?.emitMessage("{bad");

    expect(bridge.getSnapshot().state).toBe("error");
    expect(bridge.getSnapshot().lastError).toContain("Invalid codex bridge JSON");
  });

  it("records error when request arrives before handler registration", () => {
    const bridge = createCodexToolBridgeForTests({ wsFactory });
    bridge.connect("ws://localhost:1234/codex/ws");
    sockets[0]?.emitOpen();

    sockets[0]?.emitMessage(JSON.stringify({
      type: "notebook_tool_call_request",
      bridgeCallId: "bridge_2",
      toolCallInput: { foo: "bar" },
    }));

    expect(bridge.getSnapshot().state).toBe("error");
    expect(bridge.getSnapshot().lastError).toContain("handler");
  });

  it("captures websocket close reason for diagnostics", () => {
    const bridge = createCodexToolBridgeForTests({ wsFactory });
    bridge.connect("ws://localhost:1234/codex/ws");
    sockets[0]?.emitOpen();

    sockets[0]?.emitClose({ code: 4409, reason: "codex_ws_already_connected" });

    expect(bridge.getSnapshot().state).toBe("closed");
    expect(bridge.getSnapshot().lastError).toBe("codex_ws_already_connected");
  });

  it("does not send a response after disconnect during an in-flight request", async () => {
    const bridge = createCodexToolBridgeForTests({ wsFactory });
    let resolveHandler: ((value: unknown) => void) | null = null;
    bridge.setHandler(
      () =>
        new Promise((resolve) => {
          resolveHandler = resolve;
        }),
    );
    bridge.connect("ws://localhost:1234/codex/ws");
    sockets[0]?.emitOpen();

    sockets[0]?.emitMessage(JSON.stringify({
      type: "NotebookToolCallRequest",
      bridge_call_id: "bridge_3",
      tool_call_input: { call_id: "call_3" },
    }));
    sockets[0]?.emitClose({ code: 1011, reason: "server_closed" });

    resolveHandler?.({ ok: true });
    await Promise.resolve();

    expect(sockets[0]?.sent ?? []).toHaveLength(0);
    expect(bridge.getSnapshot().lastError).toBe("server_closed");
  });
});
