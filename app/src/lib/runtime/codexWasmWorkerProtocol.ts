import type { BrowserSessionOptions } from "./codexWasmHarnessLoader";

export type CodexWasmWorkerRequest =
  | {
      type: "connect";
      id: number;
      apiKey: string;
      moduleUrl: string;
      wasmUrl: string;
      sessionOptions?: BrowserSessionOptions;
    }
  | {
      type: "request";
      id: number;
      method: string;
      params?: unknown;
    }
  | {
      type: "notify";
      id: number;
      method: string;
      params?: unknown;
    }
  | {
      type: "shutdown";
      id: number;
    }
  | {
      type: "journal/query";
      id: number;
      filter?: CodexWasmJournalFilter;
    }
  | {
      type: "journal/reset";
      id: number;
    }
  | {
      type: "bridge/response";
      id: number;
      bridgeRequestId: number;
      result: string;
    }
  | {
      type: "bridge/error";
      id: number;
      bridgeRequestId: number;
      error: string;
    };

type WithoutId<T> = T extends { id: number } ? Omit<T, "id"> : never;

export type CodexWasmWorkerRequestWithoutId = WithoutId<CodexWasmWorkerRequest>;

export type CodexWasmWorkerResponse =
  | {
      type: "response";
      id: number;
      result?: unknown;
    }
  | {
      type: "response";
      id: number;
      error: string;
    }
  | {
      type: "notification";
      notification: CodexWasmAppServerNotification;
    }
  | {
      type: "bridge/request";
      bridgeRequestId: number;
      input: string;
    };

export type CodexWasmAppServerNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type CodexWasmJournalEntryDirection =
  | "client_to_server"
  | "server_to_client"
  | "worker_to_main"
  | "main_to_worker";

export type CodexWasmJournalEntryKind =
  | "request"
  | "request_result"
  | "notification"
  | "bridge_request"
  | "bridge_response"
  | "lifecycle";

export type CodexWasmJournalEntry = {
  seq: number;
  ts: string;
  sessionId: string;
  threadId?: string;
  turnId?: string;
  direction: CodexWasmJournalEntryDirection;
  kind: CodexWasmJournalEntryKind;
  method?: string;
  requestId?: number | string;
  payload: unknown;
  summary?: string;
};

export type CodexWasmJournalFilter = {
  threadId?: string;
  turnId?: string;
  sinceSeq?: number;
};
