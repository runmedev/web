import { beforeEach, describe, expect, it, vi } from "vitest";

const { appLoggerMock } = vi.hoisted(() => ({
  appLoggerMock: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../logging/runtime", () => ({
  appLogger: appLoggerMock,
}));

const defaultStreamUserMessage = async (
  _input: string,
  sink: { emit: (payload: unknown) => void },
  _model?: string,
) => {
  sink.emit({ type: "response.created", response: { id: "turn-1" } });
  sink.emit({ type: "response.output_text.delta", delta: "hello" });
  sink.emit({ type: "response.completed", response: { id: "turn-1" } });
};

const controller = {
  refreshHistory: vi.fn(),
  newChat: vi.fn(),
  getSnapshot: vi.fn(() => ({
    threads: [{ id: "thread-1", title: "One", updatedAt: "2026-02-26T00:00:00Z" }],
  })),
  getThread: vi.fn(async () => ({
    id: "thread-1",
    title: "One",
    items: [
      {
        id: "msg-user-1",
        type: "message",
        role: "user",
        status: "completed",
        createdAt: "2026-02-26T00:00:00Z",
        content: [{ type: "input_text", text: "print hello world in python" }],
      },
      {
        id: "msg-1",
        type: "message",
        role: "assistant",
        status: "completed",
        createdAt: "2026-02-26T00:01:00Z",
        content: [{ type: "output_text", text: "hello" }],
      },
    ],
  })),
  listItems: vi.fn(async () => [
      {
        id: "msg-user-1",
        type: "message",
        role: "user",
        status: "completed",
        createdAt: "2026-02-26T00:00:00Z",
        content: [{ type: "input_text", text: "print hello world in python" }],
      },
      {
        id: "msg-1",
        type: "message",
        role: "assistant",
        status: "completed",
        createdAt: "2026-02-26T00:01:00Z",
        content: [{ type: "output_text", text: "hello" }],
      },
    ]),
  ensureActiveThread: vi.fn(async () => ({
    id: "thread-1",
    title: "One",
    items: [],
  })),
  streamUserMessage: vi.fn(defaultStreamUserMessage),
  interruptActiveTurn: vi.fn(),
};

vi.mock("./codexConversationController", () => ({
  getCodexConversationController: () => controller,
}));

import { createCodexChatkitFetch } from "./codexChatKitAdapter";

function expectUserThreadItem(item: unknown): void {
  expect(item).toEqual(
    expect.objectContaining({
      id: "msg-user-1",
      thread_id: "thread-1",
      type: "user_message",
      content: [
        {
          type: "input_text",
          text: "print hello world in python",
        },
      ],
      attachments: [],
      inference_options: {},
      created_at: "2026-02-26T00:00:00Z",
    }),
  );
}

function expectAssistantThreadItem(item: unknown): void {
  expect(item).toEqual(
    expect.objectContaining({
      id: "msg-1",
      thread_id: "thread-1",
      type: "assistant_message",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "hello",
          annotations: [],
        },
      ],
      created_at: "2026-02-26T00:01:00Z",
    }),
  );
}

function expectEndOfTurnItem(item: unknown): void {
  expect(item).toEqual(
    expect.objectContaining({
      id: "msg-1-end-of-turn",
      thread_id: "thread-1",
      type: "end_of_turn",
      created_at: "2026-02-26T00:01:00Z",
    }),
  );
}

describe("createCodexChatkitFetch", () => {
  beforeEach(() => {
    appLoggerMock.info.mockClear();
    appLoggerMock.error.mockClear();
    controller.refreshHistory.mockClear();
    controller.newChat.mockClear();
    controller.getSnapshot.mockClear();
    controller.getThread.mockClear();
    controller.listItems.mockClear();
    controller.ensureActiveThread.mockClear();
    controller.streamUserMessage = vi.fn(defaultStreamUserMessage);
    controller.interruptActiveTurn.mockClear();
  });

  it("handles threads.list requests", async () => {
    const fetchFn = createCodexChatkitFetch();
    const response = await fetchFn("http://localhost/codex/app-server/ws", {
      method: "POST",
      body: JSON.stringify({ type: "threads.list" }),
    });

    expect(controller.refreshHistory).toHaveBeenCalled();
    expect(await response.json()).toEqual({
      data: [{ id: "thread-1", title: "One", updated_at: "2026-02-26T00:00:00Z" }],
      has_more: false,
    });
  });

  it("handles nested params requests", async () => {
    const fetchFn = createCodexChatkitFetch();
    const response = await fetchFn("http://localhost/codex/chatkit", {
      method: "POST",
      body: JSON.stringify({ params: { type: "threads.list" } }),
    });

    expect(controller.refreshHistory).toHaveBeenCalled();
    expect(await response.json()).toEqual({
      data: [{ id: "thread-1", title: "One", updated_at: "2026-02-26T00:00:00Z" }],
      has_more: false,
    });
  });

  it("forwards the ChatKit-selected model to the codex controller", async () => {
    const fetchFn = createCodexChatkitFetch();

    await fetchFn("http://localhost/codex/chatkit", {
      method: "POST",
      body: JSON.stringify({
        type: "threads.create",
        params: {
          input: {
            content: [{ type: "input_text", text: "hello" }],
            inference_options: {
              model: "gpt-5.4",
            },
          },
        },
      }),
    });

    expect(controller.streamUserMessage).toHaveBeenCalledWith(
      "hello",
      expect.any(Object),
      "gpt-5.4",
      null,
    );
  });

  it("emits thread.created for new Codex threads", async () => {
    controller.streamUserMessage.mockImplementationOnce(
      async (_input: string, sink: { emit: (payload: unknown) => void }) => {
        sink.emit({
          type: "thread.created",
          thread: {
            id: "thread-2",
            title: "New Codex Thread",
            created_at: "2026-02-26T00:00:00Z",
          },
        });
        sink.emit({ type: "response.created", response: { id: "turn-2" } });
        sink.emit({
          type: "response.output_text.delta",
          response_id: "turn-2",
          item_id: "msg-2",
          delta: "hello",
        });
        sink.emit({ type: "response.completed", response: { id: "turn-2" } });
      },
    );

    const fetchFn = createCodexChatkitFetch();
    const response = await fetchFn("http://localhost/codex/chatkit", {
      method: "POST",
      body: JSON.stringify({
        type: "threads.create",
        params: {
          input: {
            content: [{ type: "input_text", text: "hello" }],
          },
        },
      }),
    });

    const body = await response.text();

    expect(body).toContain('"type":"thread.created"');
    expect(body).toContain('"title":"New Codex Thread"');
  });

  it("handles threads.get_by_id requests", async () => {
    const fetchFn = createCodexChatkitFetch();
    const response = await fetchFn("http://localhost/codex/app-server/ws", {
      method: "POST",
      body: JSON.stringify({ type: "threads.get_by_id", thread_id: "thread-1" }),
    });

    expect(controller.getThread).toHaveBeenCalledWith("thread-1");
    const payload = await response.json();
    expect(payload).toEqual({
      id: "thread-1",
      title: "One",
      created_at: expect.any(String),
      status: { type: "active" },
      metadata: {},
      updated_at: undefined,
      items: {
        data: expect.any(Array),
        has_more: false,
      },
      messages: {
        data: expect.any(Array),
        has_more: false,
      },
    });
    expect(payload.items.data).toHaveLength(3);
    expectUserThreadItem(payload.items.data[0]);
    expectAssistantThreadItem(payload.items.data[1]);
    expectEndOfTurnItem(payload.items.data[2]);
    expect(payload.messages.data).toEqual(payload.items.data);
  });

  it("handles threads.get requests", async () => {
    const fetchFn = createCodexChatkitFetch();
    const response = await fetchFn("http://localhost/codex/app-server/ws", {
      method: "POST",
      body: JSON.stringify({ type: "threads.get", thread_id: "thread-1" }),
    });

    expect(controller.getThread).toHaveBeenCalledWith("thread-1");
    const payload = await response.json();
    expect(payload).toEqual({
      id: "thread-1",
      title: "One",
      created_at: expect.any(String),
      status: { type: "active" },
      metadata: {},
      updated_at: undefined,
      items: {
        data: expect.any(Array),
        has_more: false,
      },
      messages: {
        data: expect.any(Array),
        has_more: false,
      },
    });
    expect(payload.items.data).toHaveLength(3);
    expectUserThreadItem(payload.items.data[0]);
    expectAssistantThreadItem(payload.items.data[1]);
    expectEndOfTurnItem(payload.items.data[2]);
    expect(payload.messages.data).toEqual(payload.items.data);
  });

  it("handles threads.get_by_id requests with thread_id nested under params", async () => {
    const fetchFn = createCodexChatkitFetch();
    const response = await fetchFn("http://localhost/codex/app-server/ws", {
      method: "POST",
      body: JSON.stringify({
        type: "threads.get_by_id",
        params: { thread_id: "thread-1" },
      }),
    });

    expect(controller.getThread).toHaveBeenCalledWith("thread-1");
    const payload = await response.json();
    expect(payload).toEqual({
      id: "thread-1",
      title: "One",
      created_at: expect.any(String),
      status: { type: "active" },
      metadata: {},
      updated_at: undefined,
      items: {
        data: expect.any(Array),
        has_more: false,
      },
      messages: {
        data: expect.any(Array),
        has_more: false,
      },
    });
    expect(payload.items.data).toHaveLength(3);
    expectUserThreadItem(payload.items.data[0]);
    expectAssistantThreadItem(payload.items.data[1]);
    expectEndOfTurnItem(payload.items.data[2]);
    expect(payload.messages.data).toEqual(payload.items.data);
  });

  it("handles threads.get_by_id requests with id nested under params", async () => {
    const fetchFn = createCodexChatkitFetch();
    const response = await fetchFn("http://localhost/codex/app-server/ws", {
      method: "POST",
      body: JSON.stringify({
        type: "threads.get_by_id",
        params: { id: "thread-1" },
      }),
    });

    expect(controller.getThread).toHaveBeenCalledWith("thread-1");
    const payload = await response.json();
    expect(payload).toEqual({
      id: "thread-1",
      title: "One",
      created_at: expect.any(String),
      status: { type: "active" },
      metadata: {},
      items: {
        data: expect.any(Array),
        has_more: false,
      },
      messages: {
        data: expect.any(Array),
        has_more: false,
      },
    });
    expect(payload.items.data).toHaveLength(3);
    expectUserThreadItem(payload.items.data[0]);
    expectAssistantThreadItem(payload.items.data[1]);
    expectEndOfTurnItem(payload.items.data[2]);
    expect(payload.messages.data).toEqual(payload.items.data);
  });

  it("handles items.list requests with thread_id nested under params", async () => {
    const fetchFn = createCodexChatkitFetch();
    const response = await fetchFn("http://localhost/codex/app-server/ws", {
      method: "POST",
      body: JSON.stringify({
        type: "items.list",
        params: { thread_id: "thread-1" },
      }),
    });

    expect(controller.listItems).toHaveBeenCalledWith("thread-1");
    const payload = await response.json();
    expect(payload).toEqual({
      data: expect.any(Array),
      has_more: false,
    });
    expect(payload.data).toHaveLength(3);
    expectUserThreadItem(payload.data[0]);
    expectAssistantThreadItem(payload.data[1]);
    expectEndOfTurnItem(payload.data[2]);
  });

  it("handles items.list requests with id nested under params", async () => {
    const fetchFn = createCodexChatkitFetch();
    const response = await fetchFn("http://localhost/codex/app-server/ws", {
      method: "POST",
      body: JSON.stringify({
        type: "items.list",
        params: { id: "thread-1" },
      }),
    });

    expect(controller.listItems).toHaveBeenCalledWith("thread-1");
    const payload = await response.json();
    expect(payload).toEqual({
      data: expect.any(Array),
      has_more: false,
    });
    expect(payload.data).toHaveLength(3);
    expectUserThreadItem(payload.data[0]);
    expectAssistantThreadItem(payload.data[1]);
    expectEndOfTurnItem(payload.data[2]);
  });

  it("handles messages.list requests", async () => {
    const fetchFn = createCodexChatkitFetch();
    const response = await fetchFn("http://localhost/codex/app-server/ws", {
      method: "POST",
      body: JSON.stringify({
        type: "messages.list",
        params: { thread_id: "thread-1" },
      }),
    });

    expect(controller.listItems).toHaveBeenCalledWith("thread-1");
    const payload = await response.json();
    expect(payload).toEqual({
      data: expect.any(Array),
      has_more: false,
    });
    expect(payload.data).toHaveLength(3);
    expectUserThreadItem(payload.data[0]);
    expectAssistantThreadItem(payload.data[1]);
    expectEndOfTurnItem(payload.data[2]);
  });

  it("returns a structured error for unsupported non-message requests", async () => {
    const fetchFn = createCodexChatkitFetch();
    const response = await fetchFn("http://localhost/codex/app-server/ws", {
      method: "POST",
      body: JSON.stringify({
        type: "threads.load",
        params: { thread_id: "thread-1" },
      }),
    });

    expect(await response.json()).toEqual({
      data: null,
      error: "unsupported_codex_chatkit_request:threads.load",
    });
    expect(appLoggerMock.error).toHaveBeenCalledWith(
      "Unsupported Codex ChatKit fetch request",
      expect.objectContaining({
        attrs: expect.objectContaining({
          scope: "chatkit.codex_adapter",
          requestType: "threads.load",
        }),
      }),
    );
  });

  it("streams assistant events for simple input requests", async () => {
    const fetchFn = createCodexChatkitFetch();
    const response = await fetchFn("http://localhost/codex/app-server/ws", {
      method: "POST",
      body: JSON.stringify({
        input: "hello",
      }),
    });

    const body = await response.text();
    expect(controller.streamUserMessage).toHaveBeenCalledWith(
      "hello",
      expect.any(Object),
      undefined,
      null,
    );
    expect(body).toContain('"type":"response.created"');
    expect(body).toContain('"delta":"hello"');
    expect(body).toContain('"type":"response.completed"');
  });

  it("reads POST bodies from Request objects", async () => {
    const fetchFn = createCodexChatkitFetch();
    const request = new Request("http://localhost/codex/chatkit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        input: "hello from request",
      }),
    });

    const response = await fetchFn(request);
    const body = await response.text();

    expect(controller.streamUserMessage).toHaveBeenCalledWith(
      "hello from request",
      expect.any(Object),
      undefined,
      null,
    );
    expect(body).toContain('"type":"response.created"');
  });

  it("extracts nested params.input payloads", async () => {
    const fetchFn = createCodexChatkitFetch();
    const response = await fetchFn("http://localhost/codex/chatkit", {
      method: "POST",
      body: JSON.stringify({
        params: {
          input: {
            content: [{ text: "hello from nested params" }],
          },
        },
      }),
    });

    const body = await response.text();

    expect(controller.streamUserMessage).toHaveBeenCalledWith(
      "hello from nested params",
      expect.any(Object),
      undefined,
      null,
    );
    expect(body).toContain('"type":"response.created"');
  });

  it("closes the SSE stream cleanly when the request is aborted", async () => {
    const fetchFn = createCodexChatkitFetch();
    controller.streamUserMessage.mockImplementationOnce(
      async (_input: string, sink: { emit: (payload: unknown) => void }) => {
        sink.emit({ type: "response.created", response: { id: "turn-1" } });
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      },
    );

    const abortController = new AbortController();
    const responsePromise = fetchFn("http://localhost/codex/chatkit", {
      method: "POST",
      body: JSON.stringify({
        input: "hello",
      }),
      signal: abortController.signal,
    });

    abortController.abort();
    const response = await responsePromise;
    await response.text();
    expect(controller.interruptActiveTurn).toHaveBeenCalled();
    expect(appLoggerMock.info).toHaveBeenCalledWith(
      "Codex ChatKit stream abort signaled",
      expect.objectContaining({
        attrs: expect.objectContaining({
          scope: "chatkit.codex_fetch",
          requestType: "message_stream",
          inputText: "hello",
          threadId: null,
          previousResponseId: null,
          streamId: expect.any(String),
          aborted: true,
        }),
      }),
    );
    expect(appLoggerMock.info).toHaveBeenCalledWith(
      "Codex ChatKit stream abort handler completed",
      expect.objectContaining({
        attrs: expect.objectContaining({
          scope: "chatkit.codex_fetch",
          requestType: "message_stream",
          inputText: "hello",
          threadId: null,
          previousResponseId: null,
          streamId: expect.any(String),
          aborted: true,
        }),
      }),
    );
  });

  it("ignores aborts after the stream has already settled", async () => {
    const fetchFn = createCodexChatkitFetch();
    const abortController = new AbortController();

    const response = await fetchFn("http://localhost/codex/chatkit", {
      method: "POST",
      body: JSON.stringify({
        input: "hello",
      }),
      signal: abortController.signal,
    });

    await response.text();
    abortController.abort();

    expect(controller.interruptActiveTurn).not.toHaveBeenCalled();
    expect(appLoggerMock.info).toHaveBeenCalledWith(
      "Codex ChatKit stream abort ignored after stream settled",
      expect.objectContaining({
        attrs: expect.objectContaining({
          scope: "chatkit.codex_fetch",
          requestType: "message_stream",
          inputText: "hello",
          threadId: null,
          previousResponseId: null,
          streamId: expect.any(String),
          aborted: true,
          settled: true,
        }),
      }),
    );
  });

  it("logs stream producer failures", async () => {
    const fetchFn = createCodexChatkitFetch();
    controller.streamUserMessage = vi.fn(async () => {
      throw new Error("stream failed");
    });

    const response = await fetchFn("http://localhost/codex/chatkit", {
      method: "POST",
      body: JSON.stringify({
        input: "hello",
      }),
    });

    const body = await response.text();

    expect(body).toContain('"type":"response.failed"');
    expect(body).toContain("stream failed");
    expect(appLoggerMock.error).toHaveBeenCalledWith(
      "Codex ChatKit stream producer failed",
      expect.objectContaining({
        attrs: expect.objectContaining({
          scope: "chatkit.codex_fetch",
          error: "Error: stream failed",
          streamId: expect.any(String),
        }),
      }),
    );
  });
});
