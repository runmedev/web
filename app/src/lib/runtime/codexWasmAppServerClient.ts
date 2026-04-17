import { appLogger } from "../logging/runtime";
import { getCodexWasmAssetUrls, type BrowserSessionOptions } from "./codexWasmHarnessLoader";
import type { CodexProxyJsonRpcNotification } from "./codexAppServerProxyClient";
import { CodexWasmWorkerClient } from "./codexWasmWorkerClient";

export type CodexWasmClientState = "idle" | "connecting" | "open" | "closed" | "error";

export type CodexWasmAppServerClientSnapshot = {
  state: CodexWasmClientState;
  url: string | null;
  lastError: string | null;
};

class CodexWasmAppServerClient {
  private readonly workerClient: CodexWasmWorkerClient;
  private state: CodexWasmClientState = "idle";
  private lastError: string | null = null;
  private listeners = new Set<() => void>();
  private notificationHandlers = new Set<
    (notification: CodexProxyJsonRpcNotification) => void
  >();
  private connectPromise: Promise<void> | null = null;

  constructor(options?: { workerClient?: CodexWasmWorkerClient }) {
    this.workerClient = options?.workerClient ?? new CodexWasmWorkerClient();
    this.workerClient.subscribeNotifications((notification) => {
      this.notificationHandlers.forEach((handler) => {
        handler(notification);
      });
    });
  }

  getSnapshot(): CodexWasmAppServerClientSnapshot {
    return {
      state: this.state,
      url: "wasm://browser-app-server",
      lastError: this.lastError,
    };
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

  async connect(options: {
    apiKey: string;
    sessionOptions?: BrowserSessionOptions;
  }): Promise<void> {
    if (!options.apiKey.trim()) {
      this.setError(
        "Codex wasm app-server requires an OpenAI API key. Run app.responsesDirect.setAPIKey(...).",
      );
      throw new Error(
        "Codex wasm app-server requires an OpenAI API key. Run app.responsesDirect.setAPIKey(...).",
      );
    }
    if (this.state === "open" || this.state === "connecting") {
      return await (this.connectPromise ?? Promise.resolve());
    }
    this.state = "connecting";
    this.lastError = null;
    this.notify();
    const { moduleUrl, wasmUrl } = getCodexWasmAssetUrls();
    const connectPromise = this.workerClient
      .connect({
        apiKey: options.apiKey,
        moduleUrl,
        wasmUrl,
        sessionOptions: options.sessionOptions,
      })
      .then(() => {
        this.state = "open";
        this.lastError = null;
        this.notify();
      })
      .catch((error) => {
        this.setError(String(error));
        throw error;
      });
    this.connectPromise = connectPromise;
    try {
      await connectPromise;
    } finally {
      if (this.connectPromise === connectPromise) {
        this.connectPromise = null;
      }
    }
  }

  async sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.state !== "open") {
      throw new Error("Codex wasm app-server is not open");
    }
    return (await this.workerClient.request(method, params)) as T;
  }

  disconnect(): void {
    void this.workerClient.shutdown();
    this.state = "closed";
    this.notify();
  }

  async getEventJournal(): Promise<unknown[]> {
    return await this.workerClient.getEventJournal();
  }

  resetForTests(): void {
    this.disconnect();
    this.listeners.clear();
    this.notificationHandlers.clear();
    this.lastError = null;
    this.state = "idle";
  }

  private setError(message: string): void {
    this.state = "error";
    this.lastError = message;
    appLogger.error("Codex wasm app-server error", {
      attrs: {
        scope: "chatkit.codex_wasm",
        error: message,
      },
    });
    this.notify();
  }

  private notify(): void {
    this.listeners.forEach((listener) => {
      listener();
    });
  }
}

let singleton: CodexWasmAppServerClient | null = null;

export function getCodexWasmAppServerClient(): CodexWasmAppServerClient {
  if (!singleton) {
    singleton = new CodexWasmAppServerClient();
  }
  return singleton;
}

export function createCodexWasmAppServerClientForTests(options?: {
  workerClient?: CodexWasmWorkerClient;
}): CodexWasmAppServerClient {
  return new CodexWasmAppServerClient(options);
}

export function resetCodexWasmAppServerClientForTests(): void {
  singleton?.resetForTests();
  singleton = null;
}
