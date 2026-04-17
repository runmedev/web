import { appLogger } from "../logging/runtime";
import {
  getCodexAppServerProxyClient,
  type CodexProxyJsonRpcNotification,
} from "./codexAppServerProxyClient";
import { getCodexWasmAppServerClient } from "./codexWasmAppServerClient";
import type { BrowserSessionOptions } from "./codexWasmHarnessLoader";

export type CodexAppServerTransport = "proxy" | "wasm";
export type { CodexProxyJsonRpcNotification };

class CodexAppServerClient {
  private transport: CodexAppServerTransport = "proxy";
  private listeners = new Set<() => void>();
  private notificationHandlers = new Set<
    (notification: CodexProxyJsonRpcNotification) => void
  >();

  constructor() {
    const forwardNotifications =
      (transport: CodexAppServerTransport) =>
      (notification: CodexProxyJsonRpcNotification) => {
        if (this.transport !== transport) {
          return;
        }
        this.notificationHandlers.forEach((handler) => handler(notification));
      };

    getCodexAppServerProxyClient().subscribe(() => this.notify());
    getCodexWasmAppServerClient().subscribe(() => this.notify());
    getCodexAppServerProxyClient().subscribeNotifications(
      forwardNotifications("proxy"),
    );
    getCodexWasmAppServerClient().subscribeNotifications(
      forwardNotifications("wasm"),
    );
  }

  useTransport(transport: CodexAppServerTransport): void {
    if (this.transport === transport) {
      return;
    }
    this.currentClient().disconnect();
    this.transport = transport;
    this.notify();
  }

  getTransport(): CodexAppServerTransport {
    return this.transport;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeNotifications(
    handler: (notification: CodexProxyJsonRpcNotification) => void,
  ): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  getSnapshot(): { state: string; url: string | null; lastError: string | null } {
    return this.currentClient().getSnapshot();
  }

  setAuthorizationResolver(resolver: (() => Promise<string>) | null): void {
    getCodexAppServerProxyClient().setAuthorizationResolver(resolver);
  }

  async connectProxy(url: string, authorization: string): Promise<void> {
    this.useTransport("proxy");
    await getCodexAppServerProxyClient().connect(url, authorization);
  }

  async connectWasm(options: {
    apiKey: string;
    sessionOptions?: BrowserSessionOptions;
  }): Promise<void> {
    this.useTransport("wasm");
    await getCodexWasmAppServerClient().connect(options);
  }

  disconnect(): void {
    this.currentClient().disconnect();
  }

  async sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    return await this.currentClient().sendRequest<T>(method, params);
  }

  private currentClient():
    | ReturnType<typeof getCodexAppServerProxyClient>
    | ReturnType<typeof getCodexWasmAppServerClient> {
    return this.transport === "wasm"
      ? getCodexWasmAppServerClient()
      : getCodexAppServerProxyClient();
  }

  private notify(): void {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        appLogger.error("Codex app-server client listener failed", {
          attrs: {
            scope: "chatkit.codex_client",
            error: String(error),
          },
        });
      }
    });
  }
}

let singleton: CodexAppServerClient | null = null;

export function getCodexAppServerClient(): CodexAppServerClient {
  if (!singleton) {
    singleton = new CodexAppServerClient();
  }
  return singleton;
}
