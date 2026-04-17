/// <reference lib="webworker" />

import {
  appendCodexWasmJournalEntry,
  queryCodexWasmJournalEntries,
  resetCodexWasmJournalEntries,
} from "./codexWasmEventJournal";
import type {
  CodexWasmAppServerNotification,
  CodexWasmJournalEntry,
  CodexWasmWorkerRequest,
  CodexWasmWorkerResponse,
} from "./codexWasmWorkerProtocol";

type BrowserInstructionOverrides = {
  base?: string;
  developer?: string;
  user?: string;
};

type BrowserSessionOptions = {
  cwd?: string;
  instructions?: BrowserInstructionOverrides;
};

type BrowserAppServerInstance = {
  set_api_key(apiKey: string): void;
  setSessionOptions(options: BrowserSessionOptions): void;
  clearSessionOptions(): void;
  setEventHandler(handler: (event: unknown) => void): void;
  set_code_executor(executor: (input: string) => string | Promise<string>): void;
  request(request: unknown): Promise<unknown>;
  notify(notification: unknown): Promise<void>;
  shutdown(): Promise<void>;
};

type BrowserAppServerConstructor = new (apiKey: string) => BrowserAppServerInstance;

type CodexWasmGeneratedModule = {
  default: (moduleOrPath?: string | URL | Request) => Promise<unknown>;
  BrowserAppServer?: BrowserAppServerConstructor;
};

type WorkerState = {
  sessionId: string;
  seq: number;
  app: BrowserAppServerInstance | null;
  bridgeRequestId: number;
  pendingBridgeResponses: Map<
    number,
    {
      resolve: (value: string) => void;
      reject: (reason?: unknown) => void;
    }
  >;
};

const workerScope = self as DedicatedWorkerGlobalScope;

const state: WorkerState = {
  sessionId: `codex-wasm-${Math.random().toString(36).slice(2, 10)}`,
  seq: 1,
  app: null,
  bridgeRequestId: 1,
  pendingBridgeResponses: new Map(),
};

let modulePromise: Promise<CodexWasmGeneratedModule> | null = null;

function nextSeq(): number {
  const seq = state.seq;
  state.seq += 1;
  return seq;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function extractThreadTurnIds(value: unknown): { threadId?: string; turnId?: string } {
  const record = asRecord(value);
  const threadId =
    asString(record.threadId) ??
    asString(record.thread_id) ??
    asString(asRecord(record.thread).id);
  const turnId =
    asString(record.turnId) ??
    asString(record.turn_id) ??
    asString(asRecord(record.turn).id);
  return { threadId, turnId };
}

async function appendEntry(
  entry: Omit<CodexWasmJournalEntry, "seq" | "ts" | "sessionId">,
): Promise<void> {
  await appendCodexWasmJournalEntry({
    seq: nextSeq(),
    ts: new Date().toISOString(),
    sessionId: state.sessionId,
    ...entry,
  });
}

function postMessageToMain(message: CodexWasmWorkerResponse): void {
  workerScope.postMessage(message);
}

async function loadModule(
  moduleUrl: string,
  wasmUrl: string,
): Promise<CodexWasmGeneratedModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const generated = (await import(
        /* @vite-ignore */ moduleUrl
      )) as unknown as CodexWasmGeneratedModule;
      await generated.default(wasmUrl);
      if (!generated.BrowserAppServer) {
        throw new Error(
          "Generated codex wasm bundle does not export BrowserAppServer. Rebuild app/assets/generated/codex-wasm from the updated codex wasm-harness.",
        );
      }
      return generated;
    })();
  }
  return await modulePromise;
}

function createCodeExecutorBridge(): (input: string) => Promise<string> {
  return async (input: string) => {
    const bridgeRequestId = state.bridgeRequestId++;
    await appendEntry({
      direction: "worker_to_main",
      kind: "bridge_request",
      requestId: bridgeRequestId,
      payload: { input },
      summary: "code executor request",
    });
    postMessageToMain({
      type: "bridge/request",
      bridgeRequestId,
      input,
    });
    return await new Promise<string>((resolve, reject) => {
      state.pendingBridgeResponses.set(bridgeRequestId, {
        resolve,
        reject,
      });
    });
  };
}

function normalizeNotification(event: unknown): CodexWasmAppServerNotification | null {
  const record = asRecord(event);
  const method = asString(record.method);
  if (!method) {
    return null;
  }
  return {
    jsonrpc: "2.0",
    method,
    params: record.params,
  };
}

async function ensureConnected(
  apiKey: string,
  moduleUrl: string,
  wasmUrl: string,
  sessionOptions?: BrowserSessionOptions,
): Promise<void> {
  if (!state.app) {
    const generated = await loadModule(moduleUrl, wasmUrl);
    const BrowserAppServer = generated.BrowserAppServer!;
    const app = new BrowserAppServer(apiKey);
    app.setEventHandler((event: unknown) => {
      const notification = normalizeNotification(event);
      if (!notification) {
        return;
      }
      const { threadId, turnId } = extractThreadTurnIds(notification.params);
      void appendEntry({
        direction: "server_to_client",
        kind: "notification",
        method: notification.method,
        threadId,
        turnId,
        payload: notification,
      });
      postMessageToMain({
        type: "notification",
        notification,
      });
    });
    app.set_code_executor(createCodeExecutorBridge());
    if (sessionOptions) {
      app.setSessionOptions(sessionOptions);
    } else {
      app.clearSessionOptions();
    }
    await app.notify({
      method: "initialized",
    });
    state.app = app;
    await appendEntry({
      direction: "main_to_worker",
      kind: "lifecycle",
      method: "connect",
      payload: {
        sessionOptions: sessionOptions ?? null,
      },
    });
    return;
  }

  state.app.set_api_key(apiKey);
  if (sessionOptions) {
    state.app.setSessionOptions(sessionOptions);
  } else {
    state.app.clearSessionOptions();
  }
}

async function handleMessage(message: CodexWasmWorkerRequest): Promise<unknown> {
  switch (message.type) {
    case "connect": {
      await ensureConnected(
        message.apiKey,
        message.moduleUrl,
        message.wasmUrl,
        message.sessionOptions,
      );
      return { connected: true };
    }
    case "request": {
      if (!state.app) {
        throw new Error("Codex wasm app-server is not connected");
      }
      const payload = {
        id: message.id,
        method: message.method,
        params: message.params ?? {},
      };
      const ids = extractThreadTurnIds(message.params);
      await appendEntry({
        direction: "client_to_server",
        kind: "request",
        method: message.method,
        requestId: message.id,
        threadId: ids.threadId,
        turnId: ids.turnId,
        payload,
      });
      const result = await state.app.request(payload);
      const resultIds = extractThreadTurnIds(result);
      await appendEntry({
        direction: "server_to_client",
        kind: "request_result",
        method: message.method,
        requestId: message.id,
        threadId: resultIds.threadId ?? ids.threadId,
        turnId: resultIds.turnId ?? ids.turnId,
        payload: result,
      });
      return result;
    }
    case "notify": {
      if (!state.app) {
        throw new Error("Codex wasm app-server is not connected");
      }
      const payload = {
        method: message.method,
        params: message.params ?? {},
      };
      const ids = extractThreadTurnIds(message.params);
      await appendEntry({
        direction: "client_to_server",
        kind: "request",
        method: message.method,
        requestId: message.id,
        threadId: ids.threadId,
        turnId: ids.turnId,
        payload,
      });
      await state.app.notify(payload);
      return { notified: true };
    }
    case "shutdown": {
      if (state.app) {
        await state.app.shutdown();
        state.app = null;
      }
      await appendEntry({
        direction: "main_to_worker",
        kind: "lifecycle",
        method: "shutdown",
        payload: {},
      });
      return { shutdown: true };
    }
    case "journal/query":
      return await queryCodexWasmJournalEntries(message.filter);
    case "journal/reset":
      await resetCodexWasmJournalEntries();
      return { reset: true };
    case "bridge/response": {
      const pending = state.pendingBridgeResponses.get(message.bridgeRequestId);
      if (!pending) {
        return { resolved: false };
      }
      state.pendingBridgeResponses.delete(message.bridgeRequestId);
      await appendEntry({
        direction: "main_to_worker",
        kind: "bridge_response",
        requestId: message.bridgeRequestId,
        payload: { result: message.result },
      });
      pending.resolve(message.result);
      return { resolved: true };
    }
    case "bridge/error": {
      const pending = state.pendingBridgeResponses.get(message.bridgeRequestId);
      if (!pending) {
        return { resolved: false };
      }
      state.pendingBridgeResponses.delete(message.bridgeRequestId);
      await appendEntry({
        direction: "main_to_worker",
        kind: "bridge_response",
        requestId: message.bridgeRequestId,
        payload: { error: message.error },
      });
      pending.reject(new Error(message.error));
      return { resolved: true };
    }
  }
}

workerScope.onmessage = (event: MessageEvent<CodexWasmWorkerRequest>) => {
  const message = event.data;
  void (async () => {
    try {
      const result = await handleMessage(message);
      postMessageToMain({
        type: "response",
        id: message.id,
        result,
      });
    } catch (error) {
      postMessageToMain({
        type: "response",
        id: message.id,
        error: String(error),
      });
    }
  })();
};
