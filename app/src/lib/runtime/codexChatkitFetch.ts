import { appLogger } from "../logging/runtime";
import { logCodexEvent } from "./codexLogging";
import {
  getCodexConversationController,
  type ChatKitStateValue,
} from "./codexConversationController";

type BodyPayload = {
  raw: unknown;
  json: Record<string, unknown>;
};

async function resolveBody(input: RequestInfo | URL, init?: RequestInit): Promise<BodyInit | null | undefined> {
  if (init?.body != null) {
    return init.body;
  }
  if (!(input instanceof Request)) {
    return init?.body;
  }
  const clone = input.clone();
  const contentType = clone.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("multipart/form-data")) {
    try {
      return await clone.formData();
    } catch {
      return null;
    }
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    try {
      return new URLSearchParams(await clone.text());
    } catch {
      return null;
    }
  }
  try {
    return await clone.text();
  } catch {
    return null;
  }
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<BodyPayload> {
  const body = await resolveBody(input, init);
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      return { raw: parsed, json: parsed };
    } catch {
      return { raw: body, json: {} };
    }
  }
  if (body instanceof FormData) {
    const json: Record<string, unknown> = {};
    body.forEach((value, key) => {
      if (typeof value === "string") {
        try {
          json[key] = JSON.parse(value);
        } catch {
          json[key] = value;
        }
      }
    });
    return { raw: json, json };
  }
  if (body instanceof URLSearchParams) {
    const json: Record<string, unknown> = {};
    body.forEach((value, key) => {
      json[key] = value;
    });
    return { raw: json, json };
  }
  return { raw: null, json: {} };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

function buildStreamResponse(
  producer: (sink: { emit: (payload: unknown) => void }) => Promise<void>,
  options?: { signal?: AbortSignal | null; onAbort?: () => Promise<void> | void },
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) {
          return;
        }
        closed = true;
        controller.close();
      };
      const emit = (payload: unknown) => {
        if (closed) {
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      const abortHandler = async () => {
        try {
          await options?.onAbort?.();
        } finally {
          close();
        }
      };

      if (options?.signal) {
        if (options.signal.aborted) {
          void abortHandler();
          return;
        }
        options.signal.addEventListener("abort", () => {
          void abortHandler();
        }, { once: true });
      }

      void producer({ emit })
        .catch((error) => {
          appLogger.error("Codex ChatKit stream producer failed", {
            attrs: {
              scope: "chatkit.codex_fetch",
              error: String(error),
            },
          });
          emit({
            type: "response.failed",
            error: { message: String(error) },
          });
        })
        .finally(() => {
          close();
        });
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function getPayloadRecord(payload: Record<string, unknown>): Record<string, unknown> {
  const params =
    payload.params && typeof payload.params === "object" && !Array.isArray(payload.params)
      ? (payload.params as Record<string, unknown>)
      : null;
  return params ?? payload;
}

function extractInput(payload: Record<string, unknown>): string {
  const source = getPayloadRecord(payload);
  const direct = asString(source.input);
  if (direct) {
    return direct;
  }
  const inputRecord =
    source.input && typeof source.input === "object" && !Array.isArray(source.input)
      ? (source.input as Record<string, unknown>)
      : null;
  if (inputRecord) {
    const content = inputRecord.content;
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return "";
          }
          const record = item as Record<string, unknown>;
          return asString(record.text) ?? asString(record.value) ?? "";
        })
        .join("");
    }
  }
  return "";
}

function extractChatKitState(payload: Record<string, unknown>): ChatKitStateValue {
  const source = getPayloadRecord(payload);
  const stateRecord =
    source.chatkit_state && typeof source.chatkit_state === "object"
      ? (source.chatkit_state as Record<string, unknown>)
      : {};
  return {
    threadId: asString(stateRecord.threadId) ?? asString(stateRecord.thread_id),
    previousResponseId:
      asString(stateRecord.previousResponseId) ??
      asString(stateRecord.previous_response_id),
  };
}

export function createCodexChatkitFetch(): typeof fetch {
  const controller = getCodexConversationController();
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const { json } = await readBody(input, init);
      const requestType = asString(getPayloadRecord(json).type) ?? asString(json.type);
      logCodexEvent("Codex ChatKit fetch request", {
        scope: "chatkit.codex_adapter",
        direction: "outbound",
        transport: "chatkit_fetch",
        requestType,
        payload: json,
      });

      if (requestType === "threads.list") {
        await controller.refreshHistory();
        const snapshot = controller.getSnapshot();
        const payload = {
          data: snapshot.threads.map((thread) => ({
            id: thread.id,
            title: thread.title,
            updated_at: thread.updatedAt,
          })),
          has_more: false,
        };
        logCodexEvent("Codex ChatKit fetch response", {
          scope: "chatkit.codex_adapter",
          direction: "derived",
          transport: "chatkit_fetch",
          requestType,
          payload,
        });
        return jsonResponse(payload);
      }

      if (requestType === "threads.get_by_id") {
        const threadId = asString(json.thread_id) ?? asString(json.threadId);
        if (!threadId) {
          return jsonResponse({ error: "thread_id_required" });
        }
        const thread = await controller.getThread(threadId);
        const payload = {
          data: {
            id: thread.id,
            title: thread.title,
            updated_at: thread.updatedAt,
            items: {
              data: thread.items,
              has_more: false,
            },
          },
        };
        logCodexEvent("Codex ChatKit fetch response", {
          scope: "chatkit.codex_adapter",
          direction: "derived",
          transport: "chatkit_fetch",
          requestType,
          payload,
        });
        return jsonResponse(payload);
      }

      if (requestType === "items.list") {
        const threadId = asString(json.thread_id) ?? asString(json.threadId);
        if (!threadId) {
          return jsonResponse({ data: [], has_more: false });
        }
        const payload = await controller.handleListItems(threadId);
        logCodexEvent("Codex ChatKit fetch response", {
          scope: "chatkit.codex_adapter",
          direction: "derived",
          transport: "chatkit_fetch",
          requestType,
          payload,
        });
        return jsonResponse(payload);
      }

      const inputText = extractInput(json);
      if (!inputText) {
        return jsonResponse({ ok: true });
      }

      const chatkitState = extractChatKitState(json);
      return buildStreamResponse(
        async (sink) => {
          await controller.streamUserMessage(inputText, chatkitState, sink);
        },
        {
          signal: init?.signal ?? null,
          onAbort: async () => {
            await controller.interruptActiveTurn();
          },
        },
      );
    } catch (error) {
      appLogger.error("Codex ChatKit fetch shim failed", {
        attrs: {
          scope: "chatkit.codex_fetch",
          error: String(error),
        },
      });
      throw error;
    }
  };
}
