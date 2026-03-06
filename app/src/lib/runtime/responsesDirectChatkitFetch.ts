import { appLogger } from "../logging/runtime";
import { getAccessToken } from "../../token";
import { responsesDirectConfigManager } from "./responsesDirectConfigManager";
import type { ChatKitThreadDetail } from "./chatkitProtocol";

type JsonRecord = Record<string, unknown>;

type BodyPayload = {
  raw: unknown;
  json: JsonRecord;
};

type StoredThread = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  previousResponseId?: string;
  model: string;
  items: JsonRecord[];
};

const DEFAULT_OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5.2";

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
      const parsed = JSON.parse(body) as JsonRecord;
      return { raw: parsed, json: parsed };
    } catch {
      return { raw: body, json: {} };
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
    return { raw: json, json };
  }
  if (body instanceof URLSearchParams) {
    const json: JsonRecord = {};
    body.forEach((value, key) => {
      json[key] = value;
    });
    return { raw: json, json };
  }
  return { raw: null, json: {} };
}

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as JsonRecord;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function randomId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

function getPayloadRecord(payload: JsonRecord): JsonRecord {
  const params =
    payload.params && typeof payload.params === "object" && !Array.isArray(payload.params)
      ? (payload.params as JsonRecord)
      : null;
  return params ?? payload;
}

function extractInput(payload: JsonRecord): {
  text: string;
  model: string;
} {
  const source = getPayloadRecord(payload);
  const inputRecord = asRecord(source.input);
  const content = Array.isArray(inputRecord.content) ? inputRecord.content : [];
  const text = content
    .map((item) => {
      const part = asRecord(item);
      return asString(part.text) ?? asString(part.value) ?? "";
    })
    .join("")
    .trim();
  const inference = asRecord(inputRecord.inference_options);
  const model = asString(inference.model) ?? DEFAULT_MODEL;
  return { text, model };
}

function toOutputString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractToolOutput(payload: JsonRecord): {
  callId: string;
  previousResponseId: string;
  output: string;
} {
  const source = getPayloadRecord(payload);
  const result = asRecord(source.result);
  const callId = asString(result.callId) ?? asString(result.call_id) ?? "";
  const previousResponseId =
    asString(result.previousResponseId) ?? asString(result.previous_response_id) ?? "";
  const clientError = asString(result.clientError) ?? asString(result.client_error) ?? "";
  const outputValue = result.output ?? result.result;
  const output =
    clientError.length > 0 ? `Tool execution failed: ${clientError}` : toOutputString(outputValue);
  return { callId, previousResponseId, output };
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

function buildThreadDetail(thread: StoredThread): ChatKitThreadDetail {
  const messages = {
    data: thread.items,
    has_more: false,
  };
  return {
    id: thread.id,
    title: thread.title,
    created_at: thread.createdAt,
    updated_at: thread.updatedAt,
    status: { type: "active" },
    metadata: {},
    items: messages,
    messages,
  };
}

function withUpdatedThreadTitle(thread: StoredThread, text: string): void {
  if (thread.title !== "New conversation") {
    return;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  const shortened = trimmed.slice(0, 80);
  thread.title = shortened;
}

async function resolveResponsesDirectHeaders(): Promise<Headers> {
  const config = responsesDirectConfigManager.getSnapshot();
  const headers = new Headers({
    "content-type": "application/json",
  });

  if (config.authMethod === "api_key") {
    const apiKey = config.apiKey.trim();
    if (!apiKey) {
      throw new Error(
        "Direct Responses API key auth selected but no key is configured. Run app.responsesDirect.setAPIKey(...).",
      );
    }
    headers.set("Authorization", `Bearer ${apiKey}`);
    return headers;
  }

  const oauthToken = (await getAccessToken()).trim();
  if (!oauthToken) {
    throw new Error("Direct Responses OAuth requires ChatGPT sign-in.");
  }
  if (!config.openaiOrganization) {
    throw new Error(
      "Direct Responses OAuth requires OpenAI organization. Set agent.openai.organization in app-configs.yaml or use app.responsesDirect.setOpenAIOrganization(...).",
    );
  }
  if (!config.openaiProject) {
    throw new Error(
      "Direct Responses OAuth requires OpenAI project. Set agent.openai.project in app-configs.yaml or use app.responsesDirect.setOpenAIProject(...).",
    );
  }

  headers.set("Authorization", `Bearer ${oauthToken}`);
  headers.set("OpenAI-Organization", config.openaiOrganization);
  headers.set("OpenAI-Project", config.openaiProject);
  return headers;
}

function buildOpenAIResponsesRequestForInput(options: {
  text: string;
  model: string;
  previousResponseId?: string;
  vectorStores: string[];
}): JsonRecord {
  const payload: JsonRecord = {
    model: options.model || DEFAULT_MODEL,
    stream: true,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: options.text,
          },
        ],
      },
    ],
    parallel_tool_calls: false,
  };

  if (options.previousResponseId) {
    payload.previous_response_id = options.previousResponseId;
  }

  if (options.vectorStores.length > 0) {
    payload.tools = [
      {
        type: "file_search",
        max_num_results: 5,
        vector_store_ids: options.vectorStores,
      },
    ];
  }

  return payload;
}

function buildOpenAIResponsesRequestForToolOutput(options: {
  callId: string;
  output: string;
  model: string;
  previousResponseId?: string;
  vectorStores: string[];
}): JsonRecord {
  const payload: JsonRecord = {
    model: options.model || DEFAULT_MODEL,
    stream: true,
    input: [
      {
        type: "function_call_output",
        call_id: options.callId,
        output: options.output,
      },
    ],
    parallel_tool_calls: false,
  };

  if (options.previousResponseId) {
    payload.previous_response_id = options.previousResponseId;
  }

  if (options.vectorStores.length > 0) {
    payload.tools = [
      {
        type: "file_search",
        max_num_results: 5,
        vector_store_ids: options.vectorStores,
      },
    ];
  }

  return payload;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text || `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

async function consumeSSE(
  response: Response,
  onEvent: (event: JsonRecord) => void,
  signal?: AbortSignal | null,
): Promise<void> {
  if (!response.body) {
    throw new Error("Responses API returned no stream body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    if (signal?.aborted) {
      throw new Error(String(signal.reason ?? "Request aborted"));
    }
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = block.split("\n");
      const dataLines = lines
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter((line) => line.length > 0);
      if (dataLines.length > 0) {
        const data = dataLines.join("\n");
        if (data !== "[DONE]") {
          try {
            onEvent(JSON.parse(data) as JsonRecord);
          } catch (error) {
            appLogger.warn("Failed to parse OpenAI responses SSE event", {
              attrs: {
                scope: "chatkit.responses_direct",
                error: String(error),
                payload: data,
              },
            });
          }
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

function buildStreamResponse(
  producer: (sink: { emit: (payload: unknown) => void }) => Promise<void>,
  options?: { signal?: AbortSignal | null },
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
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

      if (options?.signal?.aborted) {
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
            if (!closed) {
              emit({
                type: "response.failed",
                error: { message: String(options.signal?.reason ?? "Request aborted") },
              });
            }
            close();
          },
          { once: true },
        );
      }

      void producer({ emit })
        .catch((error) => {
          emit({
            type: "response.failed",
            error: { message: String(error) },
          });
          appLogger.error("Direct Responses stream producer failed", {
            attrs: {
              scope: "chatkit.responses_direct",
              error: String(error),
            },
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

export function createResponsesDirectChatkitFetch(): typeof fetch {
  const threads = new Map<string, StoredThread>();

  const ensureThread = (threadId?: string): StoredThread => {
    const normalized = threadId?.trim() ?? "";
    if (normalized && threads.has(normalized)) {
      return threads.get(normalized)!;
    }
    const now = new Date().toISOString();
    const created: StoredThread = {
      id: normalized || randomId("thread"),
      title: "New conversation",
      createdAt: now,
      updatedAt: now,
      model: DEFAULT_MODEL,
      items: [],
    };
    threads.set(created.id, created);
    return created;
  };

  const streamOpenAI = async (options: {
    thread: StoredThread;
    requestPayload: JsonRecord;
    emit: (payload: unknown) => void;
    signal?: AbortSignal | null;
  }): Promise<void> => {
    const headers = await resolveResponsesDirectHeaders();
    const response = await fetch(DEFAULT_OPENAI_RESPONSES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(options.requestPayload),
      signal: options.signal ?? undefined,
    });
    if (!response.ok) {
      throw new Error(await readErrorBody(response));
    }

    const assistantTextByItem = new Map<string, string>();

    await consumeSSE(
      response,
      (event) => {
        const type = asString(event.type) ?? "";
        if (!type) {
          return;
        }
        switch (type) {
          case "response.created": {
            const responseRecord = asRecord(event.response);
            const responseId = asString(responseRecord.id);
            if (responseId) {
              options.thread.previousResponseId = responseId;
              options.thread.updatedAt = new Date().toISOString();
              options.emit({
                type: "aisre.chatkit.state",
                item: {
                  state: {
                    threadId: options.thread.id,
                    previousResponseId: responseId,
                  },
                },
              });
            }
            return;
          }
          case "response.output_item.added": {
            const item = asRecord(event.item);
            if (asString(item.type) !== "message") {
              return;
            }
            const itemId = asString(item.id) ?? randomId("assistant");
            assistantTextByItem.set(itemId, "");
            options.emit({
              type: "thread.item.added",
              item: {
                id: itemId,
                type: "assistant_message",
                thread_id: options.thread.id,
                created_at: new Date().toISOString(),
                status: "in_progress",
                content: [],
              },
            });
            options.emit({
              type: "thread.item.updated",
              item_id: itemId,
              update: {
                type: "assistant_message.content_part.added",
                content_index: 0,
                content: {
                  type: "output_text",
                  text: "",
                  annotations: [],
                },
              },
            });
            return;
          }
          case "response.output_text.delta": {
            const itemId = asString(event.item_id);
            const delta = asString(event.delta) ?? "";
            if (!itemId || !delta) {
              return;
            }
            assistantTextByItem.set(itemId, `${assistantTextByItem.get(itemId) ?? ""}${delta}`);
            options.emit({
              type: "thread.item.updated",
              item_id: itemId,
              update: {
                type: "assistant_message.content_part.text_delta",
                content_index: 0,
                delta,
              },
            });
            return;
          }
          case "response.output_item.done": {
            const item = asRecord(event.item);
            if (asString(item.type) !== "message") {
              return;
            }
            const itemId = asString(item.id) ?? randomId("assistant");
            const parts = Array.isArray(item.content) ? item.content : [];
            const textFromDone = parts
              .map((part) => asString(asRecord(part).text) ?? "")
              .join("");
            const finalText = textFromDone || assistantTextByItem.get(itemId) || "";
            options.emit({
              type: "thread.item.updated",
              item_id: itemId,
              update: {
                type: "assistant_message.content_part.done",
                content_index: 0,
                content: {
                  type: "output_text",
                  text: finalText,
                  annotations: [],
                },
              },
            });
            const assistantItem: JsonRecord = {
              id: itemId,
              type: "assistant_message",
              thread_id: options.thread.id,
              created_at: new Date().toISOString(),
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: finalText,
                  annotations: [],
                },
              ],
            };
            options.thread.items.push(assistantItem);
            options.thread.updatedAt = new Date().toISOString();
            return;
          }
          case "response.function_call_arguments.done": {
            const callId = asString(event.call_id) ?? "";
            const itemId = asString(event.item_id) ?? randomId("tool");
            const name = asString(event.name) ?? "unknown_tool";
            let argumentsObject: unknown = {};
            const argumentsRaw = asString(event.arguments) ?? "{}";
            try {
              argumentsObject = JSON.parse(argumentsRaw);
            } catch {
              argumentsObject = {};
            }
            const toolItem: JsonRecord = {
              id: itemId,
              type: "client_tool_call",
              thread_id: options.thread.id,
              created_at: new Date().toISOString(),
              status: "pending",
              call_id: callId,
              name,
              arguments: argumentsObject,
            };
            options.thread.items.push(toolItem);
            options.thread.updatedAt = new Date().toISOString();
            options.emit({
              type: "thread.item.done",
              item: toolItem,
            });
            return;
          }
          case "response.completed": {
            const endOfTurn: JsonRecord = {
              id: randomId("end"),
              type: "end_of_turn",
              thread_id: options.thread.id,
              created_at: new Date().toISOString(),
            };
            options.thread.items.push(endOfTurn);
            options.thread.updatedAt = new Date().toISOString();
            options.emit({
              type: "thread.item.done",
              item: endOfTurn,
            });
            return;
          }
          default:
            return;
        }
      },
      options.signal,
    );
  };

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const { json } = await readBody(input, init);
    const requestType = asString(getPayloadRecord(json).type) ?? asString(json.type) ?? "";
    appLogger.info("Direct Responses ChatKit fetch request", {
      attrs: {
        scope: "chatkit.responses_direct",
        requestType,
        payload: json,
      },
    });

    if (requestType === "threads.list") {
      const payload = {
        data: [...threads.values()].map((thread) => ({
          id: thread.id,
          title: thread.title,
          updated_at: thread.updatedAt,
        })),
        has_more: false,
      };
      return jsonResponse(payload);
    }

    if (requestType === "threads.get_by_id" || requestType === "threads.get") {
      const threadId = readThreadId(json);
      const thread = threadId ? threads.get(threadId) : undefined;
      if (!thread) {
        return new Response(JSON.stringify({ error: "thread_not_found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return jsonResponse(buildThreadDetail(thread));
    }

    if (requestType === "items.list" || requestType === "messages.list") {
      const threadId = readThreadId(json);
      const thread = threadId ? threads.get(threadId) : undefined;
      return jsonResponse({
        data: thread?.items ?? [],
        has_more: false,
      });
    }

    if (requestType === "threads.create" || requestType === "threads.add_user_message") {
      const payload = getPayloadRecord(json);
      const { text, model } = extractInput(json);
      if (!text) {
        return jsonResponse({
          data: null,
          error: "missing_user_input",
        });
      }

      const requestedThreadId =
        requestType === "threads.add_user_message" ? readThreadId(json) : undefined;
      const thread = ensureThread(requestedThreadId);
      thread.model = model || thread.model || DEFAULT_MODEL;
      withUpdatedThreadTitle(thread, text);

      const userItem: JsonRecord = {
        id: randomId("msg"),
        type: "user_message",
        thread_id: thread.id,
        created_at: new Date().toISOString(),
        content: [
          {
            type: "input_text",
            text,
          },
        ],
        attachments: [],
        quoted_text: asString(asRecord(payload.input).quoted_text),
        inference_options: {
          model: model || DEFAULT_MODEL,
        },
      };
      thread.items.push(userItem);
      thread.updatedAt = new Date().toISOString();

      const vectorStores = responsesDirectConfigManager.getSnapshot().vectorStores;
      const requestPayload = buildOpenAIResponsesRequestForInput({
        text,
        model: model || thread.model || DEFAULT_MODEL,
        previousResponseId: thread.previousResponseId,
        vectorStores,
      });

      return buildStreamResponse(
        async (sink) => {
          if (requestType === "threads.create") {
            sink.emit({
              type: "thread.created",
              thread: {
                id: thread.id,
                title: thread.title,
                created_at: thread.createdAt,
              },
            });
          }
          sink.emit({
            type: "thread.item.added",
            item: userItem,
          });
          sink.emit({
            type: "thread.item.done",
            item: userItem,
          });
          await streamOpenAI({
            thread,
            requestPayload,
            emit: sink.emit,
            signal: init?.signal ?? null,
          });
        },
        { signal: init?.signal ?? null },
      );
    }

    if (requestType === "threads.add_client_tool_output") {
      const threadId = readThreadId(json);
      if (!threadId) {
        return jsonResponse({ data: null, error: "thread_id_required" });
      }
      const thread = ensureThread(threadId);
      const { callId, previousResponseId, output } = extractToolOutput(json);
      if (!callId) {
        return jsonResponse({ data: null, error: "call_id_required" });
      }

      const vectorStores = responsesDirectConfigManager.getSnapshot().vectorStores;
      const requestPayload = buildOpenAIResponsesRequestForToolOutput({
        callId,
        output,
        model: thread.model || DEFAULT_MODEL,
        previousResponseId: previousResponseId || thread.previousResponseId,
        vectorStores,
      });

      return buildStreamResponse(
        async (sink) => {
          await streamOpenAI({
            thread,
            requestPayload,
            emit: sink.emit,
            signal: init?.signal ?? null,
          });
        },
        { signal: init?.signal ?? null },
      );
    }

    return jsonResponse({
      data: null,
      error: requestType
        ? `unsupported_responses_direct_request:${requestType}`
        : "unsupported_responses_direct_request:missing_type",
    });
  };
}
