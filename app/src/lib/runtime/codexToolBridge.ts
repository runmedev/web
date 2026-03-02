import { appLogger } from "../logging/runtime";

export type CodexToolBridgeRequestEnvelope =
  | {
      type: "NotebookToolCallRequest" | "notebook_tool_call_request";
      bridge_call_id?: string;
      bridgeCallId?: string;
      tool_call_input?: unknown;
      toolCallInput?: unknown;
    }
  | {
      notebook_tool_call_request?: {
        bridge_call_id?: string;
        bridgeCallId?: string;
        input?: unknown;
      };
      notebookToolCallRequest?: {
        bridge_call_id?: string;
        bridgeCallId?: string;
        input?: unknown;
      };
    };

export type CodexToolBridgeResponseEnvelope =
  | {
      type: "NotebookToolCallResponse";
      bridge_call_id: string;
      tool_call_output: unknown;
    }
  | {
      notebookToolCallResponse: {
        bridgeCallId: string;
        output: unknown;
      };
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

type CodexBridgeAuthEnvelope = {
  authorization: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractBridgeRequest(
  parsed: CodexToolBridgeRequestEnvelope,
): CodexToolBridgeRequest | null {
  const direct = asRecord(parsed);
  const typed = direct?.type;
  if (
    typed === "NotebookToolCallRequest" ||
    typed === "notebook_tool_call_request"
  ) {
    const bridgeCallId =
      typeof direct?.bridge_call_id === "string"
        ? direct.bridge_call_id
        : typeof direct?.bridgeCallId === "string"
          ? direct.bridgeCallId
          : "";
    if (!bridgeCallId) {
      return null;
    }
    return {
      bridgeCallId,
      toolCallInput: direct?.tool_call_input ?? direct?.toolCallInput,
    };
  }

  const nested =
    asRecord(direct?.notebook_tool_call_request) ??
    asRecord(direct?.notebookToolCallRequest);
  if (!nested) {
    return null;
  }
  const bridgeCallId =
    typeof nested.bridge_call_id === "string"
      ? nested.bridge_call_id
      : typeof nested.bridgeCallId === "string"
        ? nested.bridgeCallId
        : "";
  if (!bridgeCallId) {
    return null;
  }
  return {
    bridgeCallId,
    toolCallInput: nested.input,
  };
}

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

  async connect(url: string, authorization: string): Promise<void> {
    if (!url) {
      this.setError("Codex bridge URL is required");
      throw new Error("Codex bridge URL is required");
    }
    if (!authorization.trim()) {
      this.setError("Codex bridge websocket authorization is required");
      throw new Error("Codex bridge websocket authorization is required");
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
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        ws.onopen = () => {
          if (this.ws !== ws) {
            return;
          }
          this.state = "open";
          this.lastError = null;
          try {
            const authEnvelope: CodexBridgeAuthEnvelope = {
              authorization,
            };
            ws.send(JSON.stringify(authEnvelope));
            settled = true;
            resolve();
          } catch (error) {
            this.setError(`Failed to initialize codex bridge websocket: ${String(error)}`);
            settled = true;
            reject(error);
          }
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
          if (!settled) {
            settled = true;
            reject(new Error(errorMessage ?? "Codex bridge websocket closed"));
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
          if (!settled) {
            settled = true;
            reject(new Error(this.lastError));
          }
          this.notify();
        };
        ws.onmessage = (event) => {
          void this.handleMessage(ws, event.data);
        };
      });
    } catch (error) {
      this.setError(`Failed to connect codex bridge: ${String(error)}`);
      throw error;
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
    const request = extractBridgeRequest(parsed);
    if (!request) {
      return;
    }
    if (!request.bridgeCallId) {
      this.setError("Codex bridge request missing bridge_call_id");
      return;
    }
    if (!this.handler) {
      this.setError("Codex bridge request received before handler was registered");
      return;
    }
    try {
      const toolCallOutput = await this.handler({
        bridgeCallId: request.bridgeCallId,
        toolCallInput: request.toolCallInput,
      });
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      const response: CodexToolBridgeResponseEnvelope = {
        notebookToolCallResponse: {
          bridgeCallId: request.bridgeCallId,
          output: toolCallOutput,
        },
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
