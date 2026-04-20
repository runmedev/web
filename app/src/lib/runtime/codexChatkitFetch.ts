import { appLogger } from "../logging/runtime";
import { logCodexEvent } from "./codexLogging";
import {
  getCodexConversationController,
  type CodexConversationItem,
  type ChatKitStateValue,
} from "./codexConversationController";
import type { ChatKitThreadDetail } from "./chatkitProtocol";

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

function createCodexStreamId(): string {
  return `codex-stream-${Math.random().toString(36).slice(2, 10)}`;
}

function toChatKitThreadItems(
  threadId: string,
  items: CodexConversationItem[],
): Record<string, unknown>[] {
  const converted: Record<string, unknown>[] = [];
  for (const item of items) {
    const createdAt = item.createdAt ?? new Date().toISOString();
    if (item.role === "user") {
      converted.push({
        id: item.id,
        type: "user_message",
        thread_id: threadId,
        created_at: createdAt,
        content: item.content.map((part) => ({
          type: part.type === "input_text" ? "input_text" : "input_text",
          text: part.text,
        })),
        attachments: [],
        inference_options: {},
      });
      continue;
    }

    const assistantText = item.content
      .map((part) => part.text)
      .join("");
    converted.push({
      id: item.id,
      type: "assistant_message",
      thread_id: threadId,
      created_at: createdAt,
      status: item.status,
      content: [
        {
          type: "output_text",
          text: assistantText,
          annotations: [],
        },
      ],
    });
    if (item.status === "completed") {
      converted.push({
        id: `${item.id}-end-of-turn`,
        type: "end_of_turn",
        thread_id: threadId,
        created_at: createdAt,
      });
    }
  }
  return converted;
}

function buildStreamResponse(
  producer: (sink: { emit: (payload: unknown) => void }) => Promise<void>,
  options?: {
    signal?: AbortSignal | null;
    onAbort?: () => Promise<void> | void;
    logContext?: Record<string, unknown>;
  },
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let settled = false;
      let eventCount = 0;
      const close = () => {
        if (closed) {
          return;
        }
        closed = true;
        appLogger.info("Codex ChatKit stream closed", {
          attrs: {
            scope: "chatkit.codex_fetch",
            closed,
            settled,
            eventCount,
            ...options?.logContext,
          },
        });
        controller.close();
      };
      const emit = (payload: unknown) => {
        if (closed) {
          return;
        }
        eventCount += 1;
        appLogger.info("Codex ChatKit stream emitted event", {
          attrs: {
            scope: "chatkit.codex_fetch",
            eventCount,
            payloadType:
              payload && typeof payload === "object" && !Array.isArray(payload)
                ? asString((payload as Record<string, unknown>).type) ?? null
                : null,
            ...options?.logContext,
          },
        });
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      const abortHandler = async () => {
        if (settled || closed) {
          appLogger.info("Codex ChatKit stream abort ignored after stream settled", {
            attrs: {
              scope: "chatkit.codex_fetch",
              aborted: options?.signal?.aborted ?? false,
              abortReason: String(options?.signal?.reason ?? ""),
              settled,
              closed,
              eventCount,
              stack: new Error("abort observed after stream settled").stack,
              ...options?.logContext,
            },
          });
          return;
        }
        appLogger.info("Codex ChatKit stream abort signaled", {
          attrs: {
            scope: "chatkit.codex_fetch",
            aborted: options?.signal?.aborted ?? false,
            abortReason: String(options?.signal?.reason ?? ""),
            settled,
            closed,
            eventCount,
            stack: new Error("abort observed").stack,
            ...options?.logContext,
          },
        });
        try {
          await options?.onAbort?.();
          appLogger.info("Codex ChatKit stream abort handler completed", {
            attrs: {
              scope: "chatkit.codex_fetch",
              aborted: options?.signal?.aborted ?? false,
              abortReason: String(options?.signal?.reason ?? ""),
              settled,
              closed,
              eventCount,
              ...options?.logContext,
            },
          });
        } catch (error) {
          appLogger.error("Codex ChatKit stream abort handler failed", {
            attrs: {
              scope: "chatkit.codex_fetch",
              error: String(error),
              aborted: options?.signal?.aborted ?? false,
              abortReason: String(options?.signal?.reason ?? ""),
              settled,
              closed,
              eventCount,
              ...options?.logContext,
            },
          });
          throw error;
        } finally {
          close();
        }
      };

      if (options?.signal) {
        if (options.signal.aborted) {
          appLogger.info("Codex ChatKit stream started with aborted signal", {
            attrs: {
              scope: "chatkit.codex_fetch",
              aborted: options.signal.aborted,
              abortReason: String(options.signal.reason ?? ""),
              settled,
              closed,
              eventCount,
              ...options?.logContext,
            },
          });
          void abortHandler();
          return;
        }
        options.signal.addEventListener("abort", () => {
          void abortHandler();
        }, { once: true });
      }

      appLogger.info("Codex ChatKit stream started", {
        attrs: {
          scope: "chatkit.codex_fetch",
          settled,
          closed,
          eventCount,
          ...options?.logContext,
        },
      });

      void producer({ emit })
        .catch((error) => {
          appLogger.error("Codex ChatKit stream producer failed", {
            attrs: {
              scope: "chatkit.codex_fetch",
              error: String(error),
              settled,
              closed,
              eventCount,
              ...options?.logContext,
            },
          });
          emit({
            type: "response.failed",
            error: { message: String(error) },
          });
        })
        .finally(() => {
          settled = true;
          appLogger.info("Codex ChatKit stream settled", {
            attrs: {
              scope: "chatkit.codex_fetch",
              settled,
              closed,
              eventCount,
              ...options?.logContext,
            },
          });
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

function extractInput(payload: Record<string, unknown>): {
  text: string;
  model?: string;
} {
  const source = getPayloadRecord(payload);
  const direct = asString(source.input);
  if (direct) {
    return { text: direct };
  }
  const inputRecord =
    source.input && typeof source.input === "object" && !Array.isArray(source.input)
      ? (source.input as Record<string, unknown>)
      : null;
  if (inputRecord) {
    const inference =
      inputRecord.inference_options &&
      typeof inputRecord.inference_options === "object" &&
      !Array.isArray(inputRecord.inference_options)
        ? (inputRecord.inference_options as Record<string, unknown>)
        : null;
    const content = inputRecord.content;
    if (Array.isArray(content)) {
      return {
        text: content
          .map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
              return "";
            }
            const record = item as Record<string, unknown>;
            return asString(record.text) ?? asString(record.value) ?? "";
          })
          .join(""),
        model: asString(inference?.model),
      };
    }
  }
  return { text: "" };
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
      const isThreadListRequest = requestType === "threads.list";
      const isThreadGetRequest =
        requestType === "threads.get_by_id" || requestType === "threads.get";
      const isItemListRequest =
        requestType === "items.list" || requestType === "messages.list";
      logCodexEvent("Codex ChatKit fetch request", {
        scope: "chatkit.codex_adapter",
        direction: "outbound",
        transport: "chatkit_fetch",
        requestType,
        payload: json,
      });
      console.log("[codex-chatkit-fetch] request", JSON.stringify({ requestType, json }));

      if (isThreadListRequest) {
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
        console.log("[codex-chatkit-fetch] response", JSON.stringify({ requestType, payload }));
        return jsonResponse(payload);
      }

      if (isThreadGetRequest) {
        const source = getPayloadRecord(json);
        const threadId =
          asString(source.id) ??
          asString(source.thread_id) ??
          asString(source.threadId) ??
          asString(json.id) ??
          asString(json.thread_id) ??
          asString(json.threadId);
        if (!threadId) {
          return jsonResponse({ error: "thread_id_required" });
        }
        const thread = await controller.getThread(threadId);
        const messageCollection = {
          data: toChatKitThreadItems(threadId, thread.items),
          has_more: false,
        };
        const payload: ChatKitThreadDetail = {
          id: thread.id,
          title: thread.title,
          created_at: thread.updatedAt ?? new Date().toISOString(),
          status: { type: "active" },
          metadata: {},
          updated_at: thread.updatedAt,
          items: messageCollection,
          messages: messageCollection,
        };
        logCodexEvent("Codex ChatKit fetch response", {
          scope: "chatkit.codex_adapter",
          direction: "derived",
          transport: "chatkit_fetch",
          requestType,
          payload,
        });
        console.log("[codex-chatkit-fetch] response", JSON.stringify({ requestType, payload }));
        return jsonResponse(payload);
      }

      if (isItemListRequest) {
        const source = getPayloadRecord(json);
        const threadId =
          asString(source.id) ??
          asString(source.thread_id) ??
          asString(source.threadId) ??
          asString(json.id) ??
          asString(json.thread_id) ??
          asString(json.threadId);
        if (!threadId) {
          return jsonResponse({ data: [], has_more: false });
        }
        const payload = await controller.handleListItems(threadId);
        const derivedPayload = {
          ...payload,
          data: toChatKitThreadItems(threadId, payload.data),
        };
        logCodexEvent("Codex ChatKit fetch response", {
          scope: "chatkit.codex_adapter",
          direction: "derived",
          transport: "chatkit_fetch",
          requestType,
          payload: derivedPayload,
        });
        console.log(
          "[codex-chatkit-fetch] response",
          JSON.stringify({ requestType, payload: derivedPayload }),
        );
        return jsonResponse(derivedPayload);
      }

      const { text: inputText, model } = extractInput(json);
      if (!inputText) {
        const errorPayload = {
          data: null,
          error: requestType
            ? `unsupported_codex_chatkit_request:${requestType}`
            : "unsupported_codex_chatkit_request:missing_type",
        };
        appLogger.error("Unsupported Codex ChatKit fetch request", {
          attrs: {
            scope: "chatkit.codex_adapter",
            requestType: requestType ?? null,
            payload: json,
          },
        });
        console.error(
          "[codex-chatkit-fetch] unsupported request",
          JSON.stringify({ requestType, json, errorPayload }),
        );
        return jsonResponse(errorPayload);
      }

      const activeThread = await controller.ensureActiveThread();
      const chatkitState = extractChatKitState(json);
      const streamId = createCodexStreamId();
      return buildStreamResponse(
        async (sink) => {
          await controller.streamUserMessage(inputText, chatkitState, sink, model);
        },
        {
          signal: init?.signal ?? null,
          onAbort: async () => {
            await controller.interruptActiveTurn();
          },
          logContext: {
            streamId,
            requestType: requestType ?? "message_stream",
            inputText,
            threadId: chatkitState.threadId ?? activeThread.id,
            previousResponseId: chatkitState.previousResponseId ?? null,
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
