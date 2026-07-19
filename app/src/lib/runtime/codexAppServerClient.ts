import { appLogger } from "../logging/runtime";
import {
  type CodexProxyJsonRpcNotification,
  getCodexAppServerProxyClient,
} from "./codexAppServerProxyClient";

export type { CodexProxyJsonRpcNotification };

class CodexAppServerClient {
  private listeners = new Set<() => void>();
  private notificationHandlers = new Set<(notification: CodexProxyJsonRpcNotification) => void>();

  constructor() {
    getCodexAppServerProxyClient().subscribe(() => this.notify());
    getCodexAppServerProxyClient().subscribeNotifications((notification) => {
      this.notificationHandlers.forEach((handler) => handler(notification));
    });
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

  getSnapshot(): {
    state: string;
    url: string | null;
    lastError: string | null;
  } {
    return getCodexAppServerProxyClient().getSnapshot();
  }

  setAuthorizationResolver(resolver: (() => Promise<string>) | null): void {
    getCodexAppServerProxyClient().setAuthorizationResolver(resolver);
  }

  async connectProxy(url: string, authorization: string): Promise<void> {
    await getCodexAppServerProxyClient().connect(url, authorization);
  }

  disconnect(): void {
    getCodexAppServerProxyClient().disconnect();
  }

  async sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    return await getCodexAppServerProxyClient().sendRequest<T>(method, params);
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
