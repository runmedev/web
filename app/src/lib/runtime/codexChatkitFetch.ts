import { appLogger } from "../logging/runtime";
import {
  getCodexConversationController,
  type ChatKitStateValue,
} from "./codexConversationController";

type BodyPayload = {
  raw: unknown;
  json: Record<string, unknown>;
};

async function readBody(init?: RequestInit): Promise<BodyPayload> {
  const body = init?.body;
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
      const emit = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      const abortHandler = async () => {
        try {
          await options?.onAbort?.();
        } finally {
          controller.close();
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
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "response.failed",
                error: { message: String(error) },
              })}\n\n`,
            ),
          );
        })
        .finally(() => {
          controller.close();
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

function extractInput(payload: Record<string, unknown>): string {
  const direct = asString(payload.input);
  if (direct) {
    return direct;
  }
  const inputRecord =
    payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)
      ? (payload.input as Record<string, unknown>)
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
  const stateRecord =
    payload.chatkit_state && typeof payload.chatkit_state === "object"
      ? (payload.chatkit_state as Record<string, unknown>)
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
  return async (_input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const { json } = await readBody(init);
      const requestType = asString(json.type);

      if (requestType === "threads.list") {
        await controller.refreshHistory();
        const snapshot = controller.getSnapshot();
        return jsonResponse({
          data: snapshot.threads.map((thread) => ({
            id: thread.id,
            title: thread.title,
            updated_at: thread.updatedAt,
          })),
          has_more: false,
        });
      }

      if (requestType === "threads.get_by_id") {
        const threadId = asString(json.thread_id) ?? asString(json.threadId);
        if (!threadId) {
          return jsonResponse({ error: "thread_id_required" });
        }
        const thread = await controller.getThread(threadId);
        return jsonResponse({
          id: thread.id,
          title: thread.title,
          updated_at: thread.updatedAt,
          items: {
            data: thread.items,
            has_more: false,
          },
        });
      }

      if (requestType === "items.list") {
        const threadId = asString(json.thread_id) ?? asString(json.threadId);
        if (!threadId) {
          return jsonResponse({ data: [], has_more: false });
        }
        return jsonResponse(await controller.handleListItems(threadId));
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

