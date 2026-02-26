import { appLogger } from "../logging/runtime";

export type JsonRpcId = string | number;

export type CodexProxyClientState = "idle" | "connecting" | "open" | "closed" | "error";

export type CodexProxyClientSnapshot = {
  state: CodexProxyClientState;
  url: string | null;
  lastError: string | null;
};

export type CodexProxyJsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type CodexProxyJsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type CodexProxyJsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type CodexProxyNotificationHandler = (
  notification: CodexProxyJsonRpcNotification,
) => void;

export type WebSocketFactory = (url: string) => WebSocket;

class CodexAppServerProxyClient {
  private ws: WebSocket | null = null;
  private state: CodexProxyClientState = "idle";
  private lastError: string | null = null;
  private url: string | null = null;
  private listeners = new Set<() => void>();
  private notificationHandlers = new Set<CodexProxyNotificationHandler>();
  private readonly wsFactory: WebSocketFactory;
  private nextId = 1;
  private pending = new Map<
    JsonRpcId,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
    }
  >();

  constructor(options?: { wsFactory?: WebSocketFactory }) {
    this.wsFactory = options?.wsFactory ?? ((url) => new WebSocket(url));
  }

  getSnapshot(): CodexProxyClientSnapshot {
    return {
      state: this.state,
      url: this.url,
      lastError: this.lastError,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeNotifications(handler: CodexProxyNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  async connect(url: string): Promise<void> {
    if (!url) {
      this.setError("Codex app-server websocket URL is required");
      throw new Error("Codex app-server websocket URL is required");
    }
    if (
      this.ws &&
      this.url === url &&
      (this.state === "connecting" || this.state === "open")
    ) {
      return;
    }
    this.disconnect();

    this.url = url;
    this.state = "connecting";
    this.lastError = null;
    this.notify();

    await new Promise<void>((resolve, reject) => {
      try {
        const ws = this.wsFactory(url);
        this.ws = ws;
        ws.onopen = () => {
          if (this.ws !== ws) {
            return;
          }
          this.state = "open";
          this.lastError = null;
          this.notify();
          resolve();
        };
        ws.onclose = (event) => {
          if (this.ws !== ws) {
            return;
          }
          this.state = "closed";
          const errorMessage =
            event.reason ||
            (typeof event.code === "number" && event.code !== 1000
              ? `Codex app-server websocket closed (${event.code})`
              : null);
          if (errorMessage) {
            this.lastError = errorMessage;
            appLogger.error("Codex app-server websocket closed", {
              attrs: {
                scope: "chatkit.codex_proxy",
                code: event.code,
                reason: event.reason || undefined,
                url: this.url,
              },
            });
          }
          this.rejectPending(new Error(errorMessage ?? "Codex app-server websocket closed"));
          this.notify();
        };
        ws.onerror = () => {
          if (this.ws !== ws) {
            return;
          }
          const error = new Error("Codex app-server websocket error");
          this.setError(error.message);
          this.rejectPending(error);
          reject(error);
        };
        ws.onmessage = (event) => {
          void this.handleMessage(ws, event.data);
        };
      } catch (error) {
        this.setError(`Failed to connect codex app-server websocket: ${String(error)}`);
        reject(error);
      }
    });
  }

  disconnect(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore websocket close errors.
      }
    }
    this.ws = null;
    if (this.state !== "idle") {
      this.state = "idle";
      this.notify();
    }
  }

  async sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server websocket is not open");
    }
    const id = this.nextId++;
    const request: CodexProxyJsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
    const payload = JSON.stringify(request);

    return await new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        this.ws?.send(payload);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  resetForTests(): void {
    this.disconnect();
    this.lastError = null;
    this.url = null;
    this.nextId = 1;
    this.pending.clear();
    this.notificationHandlers.clear();
    this.listeners.clear();
    this.state = "idle";
  }

  private async handleMessage(ws: WebSocket, raw: unknown): Promise<void> {
    if (typeof raw !== "string") {
      return;
    }
    let parsed: CodexProxyJsonRpcResponse | CodexProxyJsonRpcNotification;
    try {
      parsed = JSON.parse(raw) as CodexProxyJsonRpcResponse | CodexProxyJsonRpcNotification;
    } catch (error) {
      this.setError(`Invalid codex app-server JSON: ${String(error)}`);
      return;
    }

    if ("id" in parsed && parsed.id !== undefined) {
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        return;
      }
      this.pending.delete(parsed.id);
      if ("error" in parsed && parsed.error) {
        pending.reject(
          new Error(
            `jsonrpc error (${parsed.error.code}): ${parsed.error.message}`,
          ),
        );
        return;
      }
      pending.resolve(parsed.result);
      return;
    }

    if (!("method" in parsed) || typeof parsed.method !== "string") {
      return;
    }
    if (this.ws !== ws) {
      return;
    }

    this.notificationHandlers.forEach((handler) => {
      try {
        handler(parsed);
      } catch (error) {
        appLogger.error("Codex proxy notification handler failed", {
          attrs: {
            scope: "chatkit.codex_proxy",
            error: String(error),
            method: parsed.method,
          },
        });
      }
    });
  }

  private rejectPending(error: Error): void {
    this.pending.forEach(({ reject }) => {
      reject(error);
    });
    this.pending.clear();
  }

  private setError(message: string): void {
    this.lastError = message;
    this.state = "error";
    appLogger.error("Codex app-server websocket error", {
      attrs: {
        scope: "chatkit.codex_proxy",
        error: message,
        url: this.url,
      },
    });
    this.notify();
  }

  private notify(): void {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        appLogger.error("CodexAppServerProxyClient listener failed", {
          attrs: {
            scope: "chatkit.codex_proxy",
            error: String(error),
          },
        });
      }
    });
  }
}

let singleton: CodexAppServerProxyClient | null = null;

export function getCodexAppServerProxyClient(): CodexAppServerProxyClient {
  if (!singleton) {
    singleton = new CodexAppServerProxyClient();
  }
  return singleton;
}

export function createCodexAppServerProxyClientForTests(options?: {
  wsFactory?: WebSocketFactory;
}): CodexAppServerProxyClient {
  return new CodexAppServerProxyClient(options);
}

export function resetCodexAppServerProxyClientForTests(): void {
  singleton?.resetForTests();
  singleton = null;
}

