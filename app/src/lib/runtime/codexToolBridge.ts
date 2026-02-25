import { appLogger } from "../logging/runtime";

export type CodexToolBridgeRequestEnvelope = {
  type: "NotebookToolCallRequest" | "notebook_tool_call_request";
  bridge_call_id?: string;
  bridgeCallId?: string;
  tool_call_input?: unknown;
  toolCallInput?: unknown;
};

export type CodexToolBridgeResponseEnvelope = {
  type: "NotebookToolCallResponse";
  bridge_call_id: string;
  tool_call_output: unknown;
};

export type CodexToolBridgeState = "idle" | "connecting" | "open" | "closed" | "error";

export type CodexToolBridgeSnapshot = {
  state: CodexToolBridgeState;
  url: string | null;
  lastError: string | null;
};

export type CodexToolBridgeRequest = {
  bridgeCallId: string;
  toolCallInput: unknown;
};

export type CodexToolBridgeHandler = (request: CodexToolBridgeRequest) => Promise<unknown>;

export type WebSocketFactory = (url: string) => WebSocket;

class CodexToolBridge {
  private ws: WebSocket | null = null;
  private state: CodexToolBridgeState = "idle";
  private lastError: string | null = null;
  private url: string | null = null;
  private listeners = new Set<() => void>();
  private handler: CodexToolBridgeHandler | null = null;
  private readonly wsFactory: WebSocketFactory;

  constructor(options?: { wsFactory?: WebSocketFactory }) {
    this.wsFactory = options?.wsFactory ?? ((url) => new WebSocket(url));
  }

  setHandler(handler: CodexToolBridgeHandler | null): void {
    this.handler = handler;
  }

  getSnapshot(): CodexToolBridgeSnapshot {
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

  connect(url: string): void {
    if (!url) {
      this.setError("Codex bridge URL is required");
      return;
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
      };
      ws.onclose = (event) => {
        if (this.ws !== ws) {
          return;
        }
        this.state = "closed";
        let errorMessage: string | null = null;
        if (event.reason) {
          errorMessage = event.reason;
        } else if (typeof event.code === "number" && event.code !== 1000) {
          errorMessage = `Codex bridge websocket closed (${event.code})`;
        }
        if (errorMessage) {
          this.lastError = errorMessage;
          appLogger.error("Codex bridge websocket closed", {
            attrs: {
              scope: "chatkit.codex_bridge",
              code: event.code,
              reason: event.reason || undefined,
              url: this.url,
            },
          });
        }
        this.notify();
      };
      ws.onerror = () => {
        if (this.ws !== ws) {
          return;
        }
        this.state = "error";
        this.lastError = this.lastError ?? "Codex bridge websocket error";
        appLogger.error("Codex bridge websocket error", {
          attrs: {
            scope: "chatkit.codex_bridge",
            url: this.url,
            state: this.state,
          },
        });
        this.notify();
      };
      ws.onmessage = (event) => {
        void this.handleMessage(ws, event.data);
      };
    } catch (error) {
      this.setError(`Failed to connect codex bridge: ${String(error)}`);
    }
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

  resetForTests(): void {
    this.disconnect();
    this.lastError = null;
    this.url = null;
    this.handler = null;
    this.state = "idle";
    this.notify();
  }

  private async handleMessage(ws: WebSocket, raw: unknown): Promise<void> {
    if (typeof raw !== "string") {
      return;
    }
    let parsed: CodexToolBridgeRequestEnvelope;
    try {
      parsed = JSON.parse(raw) as CodexToolBridgeRequestEnvelope;
    } catch (error) {
      this.setError(`Invalid codex bridge JSON: ${String(error)}`);
      return;
    }
    const type = parsed.type;
    if (type !== "NotebookToolCallRequest" && type !== "notebook_tool_call_request") {
      return;
    }
    const bridgeCallId = parsed.bridge_call_id ?? parsed.bridgeCallId ?? "";
    if (!bridgeCallId) {
      this.setError("Codex bridge request missing bridge_call_id");
      return;
    }
    if (!this.handler) {
      this.setError("Codex bridge request received before handler was registered");
      return;
    }
    try {
      const toolCallOutput = await this.handler({
        bridgeCallId,
        toolCallInput: parsed.tool_call_input ?? parsed.toolCallInput,
      });
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      const response: CodexToolBridgeResponseEnvelope = {
        type: "NotebookToolCallResponse",
        bridge_call_id: bridgeCallId,
        tool_call_output: toolCallOutput,
      };
      ws.send(JSON.stringify(response));
    } catch (error) {
      this.setError(`Codex bridge handler failed: ${String(error)}`);
    }
  }

  private setError(message: string): void {
    this.lastError = message;
    this.state = "error";
    appLogger.error("Codex bridge error", {
      attrs: {
        scope: "chatkit.codex_bridge",
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
        appLogger.error("CodexToolBridge listener failed", {
          attrs: {
            scope: "chatkit.codex_bridge",
            error: String(error),
          },
        });
      }
    });
  }
}

let singleton: CodexToolBridge | null = null;

export function getCodexToolBridge(): CodexToolBridge {
  if (!singleton) {
    singleton = new CodexToolBridge();
  }
  return singleton;
}

export function createCodexToolBridgeForTests(options?: {
  wsFactory?: WebSocketFactory;
}): CodexToolBridge {
  return new CodexToolBridge(options);
}

export function resetCodexToolBridgeForTests(): void {
  singleton?.resetForTests();
  singleton = null;
}
