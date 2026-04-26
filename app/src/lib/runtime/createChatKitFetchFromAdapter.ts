import { appLogger } from "../logging/runtime";
import type { HarnessChatKitAdapter } from "./harnessChatKitAdapter";

type JsonRecord = Record<string, unknown>;

type BodyPayload = {
  json: JsonRecord;
};

type ParsedChatKitRequest =
  | { type: "threads.list" }
  | { type: "threads.get"; threadId: string }
  | { type: "items.list"; threadId: string }
  | {
      type: "threads.add_user_message";
      threadId?: string;
      input: string;
      model?: string;
      createThread: boolean;
      requestTypeLabel: string;
    }
  | { type: "unsupported"; requestType?: string };

async function resolveBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<BodyInit | null | undefined> {
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

async function readBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<BodyPayload> {
  const body = await resolveBody(input, init);
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as JsonRecord;
      return { json: parsed };
    } catch {
      return { json: {} };
    }
  }
  if (body instanceof FormData) {
    const json: JsonRecord = {};
    body.forEach((value, key) => {
      if (typeof value === "string") {
        try {
          json[key] = JSON.parse(value);
        } catch {
          json[key] = value;
        }
      }
    });
    return { json };
  }
  if (body instanceof URLSearchParams) {
    const json: JsonRecord = {};
    body.forEach((value, key) => {
      json[key] = value;
    });
    return { json };
  }
  return { json: {} };
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function getPayloadRecord(payload: JsonRecord): JsonRecord {
  const params =
    payload.params && typeof payload.params === "object" && !Array.isArray(payload.params)
      ? (payload.params as JsonRecord)
      : null;
  return params ?? payload;
}

function extractInput(payload: JsonRecord): { text: string; model?: string } {
  const source = getPayloadRecord(payload);
  const direct = asString(source.input);
  if (direct) {
    return { text: direct };
  }
  const inputRecord = asRecord(source.input);
  const inference = asRecord(inputRecord.inference_options);
  const content = Array.isArray(inputRecord.content) ? inputRecord.content : [];
  const text = content
    .map((item) => {
      const record = asRecord(item);
      return asString(record.text) ?? asString(record.value) ?? "";
    })
    .join("");
  return {
    text,
    model: asString(inference.model),
  };
}

function readThreadId(payload: JsonRecord): string {
  const source = getPayloadRecord(payload);
  return (
    asString(source.id) ??
    asString(source.thread_id) ??
    asString(source.threadId) ??
    asString(payload.id) ??
    asString(payload.thread_id) ??
    asString(payload.threadId) ??
    ""
  );
}

function parseChatKitRequest(payload: JsonRecord): ParsedChatKitRequest {
  const requestType = asString(getPayloadRecord(payload).type) ?? asString(payload.type);
  if (requestType === "threads.list") {
    return { type: "threads.list" };
  }
  if (requestType === "threads.get_by_id" || requestType === "threads.get") {
    const threadId = readThreadId(payload);
    return threadId ? { type: "threads.get", threadId } : { type: "unsupported", requestType };
  }
  if (requestType === "items.list" || requestType === "messages.list") {
    const threadId = readThreadId(payload);
    return threadId ? { type: "items.list", threadId } : { type: "unsupported", requestType };
  }
  if (requestType === "threads.create" || requestType === "threads.add_user_message") {
    const { text, model } = extractInput(payload);
    return {
      type: "threads.add_user_message",
      threadId: requestType === "threads.add_user_message" ? readThreadId(payload) || undefined : undefined,
      input: text,
      model,
      createThread: requestType === "threads.create",
      requestTypeLabel: requestType,
    };
  }
  const { text, model } = extractInput(payload);
  if (text) {
    return {
      type: "threads.add_user_message",
      threadId: readThreadId(payload) || undefined,
      input: text,
      model,
      createThread: false,
      requestTypeLabel: "message_stream",
    };
  }
  return { type: "unsupported", requestType };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

function buildSseResponse(
  producer: (sink: { emit: (payload: unknown) => void }) => Promise<void>,
  options?: {
    signal?: AbortSignal | null;
    onAbort?: () => Promise<void> | void;
    log?: {
      scope: string;
      streamId?: string;
      context?: Record<string, unknown>;
      producerFailedMessage?: string;
      abortMessages?: {
        signaled: string;
        completed: string;
        ignored: string;
      };
    };
  },
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let settled = false;
      const emit = (payload: unknown) => {
        if (closed) {
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      const close = () => {
        if (closed) {
          return;
        }
        closed = true;
        controller.close();
      };

      const logContext = {
        ...options?.log?.context,
        streamId: options?.log?.streamId,
      };

      if (options?.signal?.aborted) {
        if (options?.log?.abortMessages) {
          appLogger.info(options.log.abortMessages.signaled, {
            attrs: {
              scope: options.log.scope,
              aborted: options.signal.aborted,
              ...logContext,
            },
          });
        }
        void Promise.resolve(options?.onAbort?.()).finally(() => {
          if (options?.log?.abortMessages) {
            appLogger.info(options.log.abortMessages.completed, {
              attrs: {
                scope: options.log.scope,
                aborted: options.signal?.aborted ?? false,
                ...logContext,
              },
            });
          }
        });
        emit({
          type: "response.failed",
          error: { message: String(options.signal.reason ?? "Request aborted") },
        });
        close();
        return;
      }

      if (options?.signal) {
        options.signal.addEventListener(
          "abort",
          () => {
            void (async () => {
              if (settled || closed) {
                if (options?.log?.abortMessages) {
                  appLogger.info(options.log.abortMessages.ignored, {
                    attrs: {
                      scope: options.log.scope,
                      aborted: options.signal?.aborted ?? false,
                      settled,
                      ...logContext,
                    },
                  });
                }
                return;
              }
              if (options?.log?.abortMessages) {
                appLogger.info(options.log.abortMessages.signaled, {
                  attrs: {
                    scope: options.log.scope,
                    aborted: options.signal?.aborted ?? false,
                    ...logContext,
                  },
                });
              }
              try {
                await options?.onAbort?.();
                if (options?.log?.abortMessages) {
                  appLogger.info(options.log.abortMessages.completed, {
                    attrs: {
                      scope: options.log.scope,
                      aborted: options.signal?.aborted ?? false,
                      ...logContext,
                    },
                  });
                }
              } finally {
                emit({
                  type: "response.failed",
                  error: { message: String(options.signal?.reason ?? "Request aborted") },
                });
                close();
              }
            })();
          },
          { once: true },
        );
      }

      void producer({ emit })
        .catch((error) => {
          if (options?.log?.producerFailedMessage) {
            appLogger.error(options.log.producerFailedMessage, {
              attrs: {
                scope: options.log.scope,
                error: String(error),
                ...logContext,
              },
            });
          }
          emit({
            type: "response.failed",
            error: { message: String(error) },
          });
        })
        .finally(() => {
          settled = true;
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

export function createChatKitFetchFromAdapter(
  adapter: HarnessChatKitAdapter,
  options?: {
    unsupportedRequestPrefix?: string;
    missingUserInputError?: string;
    resolveModel?: () => string | undefined;
    onUnsupportedRequest?: (requestType: string | undefined, payload: JsonRecord) => void;
    onAbort?: () => Promise<void> | void;
    streamLog?: {
      scope: string;
      createStreamId?: () => string;
      buildContext?: (
        request: ParsedChatKitRequest,
      ) => Record<string, unknown> | Promise<Record<string, unknown>>;
      producerFailedMessage?: string;
      abortMessages?: {
        signaled: string;
        completed: string;
        ignored: string;
      };
    };
  },
): typeof fetch {
  const unsupportedRequestPrefix =
    options?.unsupportedRequestPrefix ?? "unsupported_chatkit_request";
  const missingUserInputError = options?.missingUserInputError ?? "missing_user_input";

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const { json } = await readBody(input, init);
    const request = parseChatKitRequest(json);

    switch (request.type) {
      case "threads.list":
        return jsonResponse({
          data: await adapter.listThreads({
            signal: init?.signal ?? null,
          }),
          has_more: false,
        });
      case "threads.get":
        return jsonResponse(
          await adapter.getThread(request.threadId, {
            signal: init?.signal ?? null,
          }),
        );
      case "items.list":
        return jsonResponse({
          data: await adapter.listItems(request.threadId, {
            signal: init?.signal ?? null,
          }),
          has_more: false,
        });
      case "threads.add_user_message":
        if (!request.input) {
          return jsonResponse({
            data: null,
            error: missingUserInputError,
          });
        }
        const streamId = options?.streamLog?.createStreamId?.();
        const streamContext = options?.streamLog?.buildContext
          ? await options.streamLog.buildContext(request)
          : undefined;
        return buildSseResponse((sink) =>
          adapter.streamUserMessage(
            {
              threadId: request.threadId,
              input: request.input,
              model: request.model ?? options?.resolveModel?.(),
              createThread: request.createThread,
              signal: init?.signal ?? null,
            },
            sink,
          ), {
            signal: init?.signal ?? null,
            onAbort: options?.onAbort,
            log: options?.streamLog
              ? {
                  scope: options.streamLog.scope,
                  streamId,
                  context: streamContext,
                  producerFailedMessage: options.streamLog.producerFailedMessage,
                  abortMessages: options.streamLog.abortMessages,
                }
              : undefined,
          });
      case "unsupported":
      default:
        options?.onUnsupportedRequest?.(request.requestType, json);
        return jsonResponse({
          data: null,
          error: request.requestType
            ? `${unsupportedRequestPrefix}:${request.requestType}`
            : `${unsupportedRequestPrefix}:missing_type`,
        });
    }
  };
}
