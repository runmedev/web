import type { BrowserSessionOptions } from "./codexWasmHarnessLoader";
import type {
  CodexWasmAppServerNotification,
  CodexWasmJournalEntry,
  CodexWasmJournalFilter,
  CodexWasmWorkerRequest,
  CodexWasmWorkerRequestWithoutId,
  CodexWasmWorkerResponse,
} from "./codexWasmWorkerProtocol";

export type CodexWasmWorkerFactory = () => Worker;
export type CodexWasmCodeExecutor = (input: string) => string | Promise<string>;

type WorkerNotificationHandler = (notification: CodexWasmAppServerNotification) => void;
type BridgeRequestMessage = Extract<CodexWasmWorkerResponse, { type: "bridge/request" }>;

function createDefaultCodeExecutorResult(errorText: string): string {
  return JSON.stringify({
    output: "",
    stored_values: {},
    error_text: errorText,
  });
}

export class CodexWasmWorkerClient {
  private worker: Worker | null = null;
  private readonly workerFactory: CodexWasmWorkerFactory;
  private nextId = 1;
  private codeExecutor: CodexWasmCodeExecutor | null = null;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
    }
  >();
  private notificationHandlers = new Set<WorkerNotificationHandler>();

  constructor(options?: { workerFactory?: CodexWasmWorkerFactory }) {
    this.workerFactory =
      options?.workerFactory ??
      (() =>
        new Worker(new URL("./codexWasmWorker.ts", import.meta.url), {
          type: "module",
        }));
  }

  subscribeNotifications(handler: WorkerNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  setCodeExecutor(executor: CodexWasmCodeExecutor | null): void {
    this.codeExecutor = executor;
  }

  async connect(options: {
    apiKey: string;
    moduleUrl: string;
    wasmUrl: string;
    sessionOptions?: BrowserSessionOptions;
  }): Promise<void> {
    const worker = this.ensureWorker();
    await this.sendMessage({
      type: "connect",
      apiKey: options.apiKey,
      moduleUrl: options.moduleUrl,
      wasmUrl: options.wasmUrl,
      sessionOptions: options.sessionOptions,
    }, worker);
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    return await this.sendMessage({
      type: "request",
      method,
      params,
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.sendMessage({
      type: "notify",
      method,
      params,
    });
  }

  async shutdown(): Promise<void> {
    if (!this.worker) {
      return;
    }
    try {
      await this.sendMessage({
        type: "shutdown",
      });
    } finally {
      this.worker.terminate();
      this.worker = null;
      this.pending.clear();
    }
  }

  async getEventJournal(filter?: CodexWasmJournalFilter): Promise<CodexWasmJournalEntry[]> {
    return (await this.sendMessage({
      type: "journal/query",
      filter,
    })) as CodexWasmJournalEntry[];
  }

  async resetEventJournal(): Promise<void> {
    await this.sendMessage({
      type: "journal/reset",
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }
    const worker = this.workerFactory();
    worker.onmessage = (event: MessageEvent<CodexWasmWorkerResponse>) => {
      this.handleWorkerMessage(event.data);
    };
    worker.onerror = (event: ErrorEvent) => {
      const error = new Error(event.message || "Codex wasm worker error");
      this.rejectPending(error);
    };
    this.worker = worker;
    return worker;
  }

  private async sendMessage(
    message: CodexWasmWorkerRequestWithoutId,
    worker = this.ensureWorker(),
  ): Promise<unknown> {
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
      });
      worker.postMessage({
        ...message,
        id,
      } as CodexWasmWorkerRequest);
    });
  }

  private handleWorkerMessage(message: CodexWasmWorkerResponse): void {
    if (message.type === "notification") {
      this.notificationHandlers.forEach((handler) => {
        handler(message.notification);
      });
      return;
    }

    if (message.type === "bridge/request") {
      void this.handleBridgeRequest(message);
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if ("error" in message && typeof message.error === "string") {
      pending.reject(new Error(message.error));
      return;
    }
    pending.resolve("result" in message ? message.result : undefined);
  }

  private rejectPending(error: Error): void {
    this.pending.forEach(({ reject }) => reject(error));
    this.pending.clear();
  }

  private async handleBridgeRequest(message: BridgeRequestMessage): Promise<void> {
    if (!this.codeExecutor) {
      this.postMessageToWorker({
        type: "bridge/response",
        bridgeRequestId: message.bridgeRequestId,
        result: createDefaultCodeExecutorResult(
          "Codex wasm code execution bridge is not configured in the main thread.",
        ),
      });
      return;
    }

    try {
      const result = await this.codeExecutor(message.input);
      this.postMessageToWorker({
        type: "bridge/response",
        bridgeRequestId: message.bridgeRequestId,
        result: typeof result === "string" ? result : String(result ?? ""),
      });
    } catch (error) {
      this.postMessageToWorker({
        type: "bridge/error",
        bridgeRequestId: message.bridgeRequestId,
        error: String(error),
      });
    }
  }

  private postMessageToWorker(message: CodexWasmWorkerRequestWithoutId): void {
    this.worker?.postMessage({
      ...message,
      id: this.nextId++,
    } satisfies CodexWasmWorkerRequest);
  }
}
