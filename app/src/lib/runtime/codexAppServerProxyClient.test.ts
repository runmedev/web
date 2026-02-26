import { beforeEach, describe, expect, it, vi } from "vitest";

const { appLoggerMock } = vi.hoisted(() => ({
  appLoggerMock: {
    error: vi.fn(),
  },
}));

vi.mock("../logging/runtime", () => ({
  appLogger: appLoggerMock,
}));

import {
  createCodexAppServerProxyClientForTests,
  type WebSocketFactory,
} from "./codexAppServerProxyClient";

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

  constructor(public readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "" } as CloseEvent);
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

  emitError(): void {
    this.onerror?.({} as Event);
  }
}

describe("CodexAppServerProxyClient", () => {
  let sockets: FakeWebSocket[];
  let wsFactory: WebSocketFactory;

  beforeEach(() => {
    sockets = [];
    appLoggerMock.error.mockClear();
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = {
      OPEN: FakeWebSocket.OPEN,
    } as typeof WebSocket;
    wsFactory = (url: string) => {
      const ws = new FakeWebSocket(url);
      sockets.push(ws);
      return ws as unknown as WebSocket;
    };
  });

  it("connects and reports open state", async () => {
    const client = createCodexAppServerProxyClientForTests({ wsFactory });

    const connectPromise = client.connect("ws://localhost:1234/codex/app-server/ws");
    expect(client.getSnapshot().state).toBe("connecting");

    sockets[0]?.emitOpen();
    await connectPromise;

    expect(client.getSnapshot().state).toBe("open");
  });

  it("sends JSON-RPC requests and resolves responses", async () => {
    const client = createCodexAppServerProxyClientForTests({ wsFactory });
    const connectPromise = client.connect("ws://localhost:1234/codex/app-server/ws");
    sockets[0]?.emitOpen();
    await connectPromise;

    const responsePromise = client.sendRequest("thread/list", {
      cwd: "/workspace",
    });
    expect(JSON.parse(sockets[0]?.sent[0] ?? "{}")).toMatchObject({
      jsonrpc: "2.0",
      method: "thread/list",
      params: { cwd: "/workspace" },
    });

    sockets[0]?.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          threads: [{ id: "thread_1" }],
        },
      }),
    );

    await expect(responsePromise).resolves.toEqual({
      threads: [{ id: "thread_1" }],
    });
  });

  it("surfaces JSON-RPC errors", async () => {
    const client = createCodexAppServerProxyClientForTests({ wsFactory });
    const connectPromise = client.connect("ws://localhost:1234/codex/app-server/ws");
    sockets[0]?.emitOpen();
    await connectPromise;

    const responsePromise = client.sendRequest("thread/read", {
      threadId: "missing",
    });
    sockets[0]?.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32600,
          message: "thread missing",
        },
      }),
    );

    await expect(responsePromise).rejects.toThrow(
      "jsonrpc error (-32600): thread missing",
    );
  });

  it("dispatches notifications to subscribers", async () => {
    const client = createCodexAppServerProxyClientForTests({ wsFactory });
    const connectPromise = client.connect("ws://localhost:1234/codex/app-server/ws");
    sockets[0]?.emitOpen();
    await connectPromise;

    const handler = vi.fn();
    client.subscribeNotifications(handler);

    sockets[0]?.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn.completed",
        params: {
          threadId: "thread_1",
          turnId: "turn_1",
        },
      }),
    );

    expect(handler).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      method: "turn.completed",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
      },
    });
  });

  it("rejects pending requests on websocket close", async () => {
    const client = createCodexAppServerProxyClientForTests({ wsFactory });
    const connectPromise = client.connect("ws://localhost:1234/codex/app-server/ws");
    sockets[0]?.emitOpen();
    await connectPromise;

    const responsePromise = client.sendRequest("turn/start", {
      threadId: "thread_1",
      input: "hello",
    });
    sockets[0]?.emitClose({ code: 1011, reason: "proxy_closed" });

    await expect(responsePromise).rejects.toThrow("proxy_closed");
    expect(client.getSnapshot().lastError).toBe("proxy_closed");
  });

  it("logs websocket connection errors through appLogger", async () => {
    const client = createCodexAppServerProxyClientForTests({ wsFactory });

    const connectPromise = client.connect("ws://localhost:1234/codex/app-server/ws");
    sockets[0]?.emitError();

    await expect(connectPromise).rejects.toThrow(
      "Codex app-server websocket error",
    );
    expect(appLoggerMock.error).toHaveBeenCalledWith(
      "Codex app-server websocket error",
      {
        attrs: {
          scope: "chatkit.codex_proxy",
          error: "Codex app-server websocket error",
          url: "ws://localhost:1234/codex/app-server/ws",
        },
      },
    );
  });
});
