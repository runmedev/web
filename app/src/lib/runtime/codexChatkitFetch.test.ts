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
  _state: unknown,
  sink: { emit: (payload: unknown) => void },
) => {
  sink.emit({ type: "response.created", response: { id: "turn-1" } });
  sink.emit({ type: "response.output_text.delta", delta: "hello" });
  sink.emit({
    type: "aisre.chatkit.state",
    item: { state: { threadId: "thread-1", previousResponseId: "turn-1" } },
  });
  sink.emit({ type: "response.completed", response: { id: "turn-1" } });
  return { threadId: "thread-1", previousResponseId: "turn-1" };
};

const controller = {
  refreshHistory: vi.fn(),
  getSnapshot: vi.fn(() => ({
    threads: [{ id: "thread-1", title: "One", updatedAt: "2026-02-26T00:00:00Z" }],
  })),
  getThread: vi.fn(async () => ({
    id: "thread-1",
    title: "One",
    items: [
      {
        id: "msg-1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hello" }],
      },
    ],
  })),
  handleListItems: vi.fn(async () => ({
    data: [
      {
        id: "msg-1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hello" }],
      },
    ],
    has_more: false,
  })),
  streamUserMessage: vi.fn(defaultStreamUserMessage),
  interruptActiveTurn: vi.fn(),
};

vi.mock("./codexConversationController", () => ({
  getCodexConversationController: () => controller,
}));

import { createCodexChatkitFetch } from "./codexChatkitFetch";

describe("createCodexChatkitFetch", () => {
  beforeEach(() => {
    appLoggerMock.info.mockClear();
    appLoggerMock.error.mockClear();
    controller.refreshHistory.mockClear();
    controller.getSnapshot.mockClear();
    controller.getThread.mockClear();
    controller.handleListItems.mockClear();
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

  it("handles threads.get_by_id requests", async () => {
    const fetchFn = createCodexChatkitFetch();
    const response = await fetchFn("http://localhost/codex/app-server/ws", {
      method: "POST",
      body: JSON.stringify({ type: "threads.get_by_id", thread_id: "thread-1" }),
    });

    expect(controller.getThread).toHaveBeenCalledWith("thread-1");
    expect(await response.json()).toEqual({
      data: {
        id: "thread-1",
        title: "One",
        updated_at: undefined,
        items: {
          data: [
            {
              id: "msg-1",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "hello" }],
            },
          ],
          has_more: false,
        },
      },
    });
  });

  it("streams assistant events for simple input requests", async () => {
    const fetchFn = createCodexChatkitFetch();
    const response = await fetchFn("http://localhost/codex/app-server/ws", {
      method: "POST",
      body: JSON.stringify({
        input: "hello",
        chatkit_state: {},
      }),
    });

    const body = await response.text();
    expect(controller.streamUserMessage).toHaveBeenCalledWith(
      "hello",
      { threadId: undefined, previousResponseId: undefined },
      expect.any(Object),
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
        chatkit_state: {},
      }),
    });

    const response = await fetchFn(request);
    const body = await response.text();

    expect(controller.streamUserMessage).toHaveBeenCalledWith(
      "hello from request",
      { threadId: undefined, previousResponseId: undefined },
      expect.any(Object),
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
          chatkit_state: {},
        },
      }),
    });

    const body = await response.text();

    expect(controller.streamUserMessage).toHaveBeenCalledWith(
      "hello from nested params",
      { threadId: undefined, previousResponseId: undefined },
      expect.any(Object),
    );
    expect(body).toContain('"type":"response.created"');
  });

  it("closes the SSE stream cleanly when the request is aborted", async () => {
    const fetchFn = createCodexChatkitFetch();
    controller.streamUserMessage.mockImplementationOnce(
      async (_input: string, _state: unknown, sink: { emit: (payload: unknown) => void }) => {
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
        chatkit_state: {},
      }),
      signal: abortController.signal,
    });

    abortController.abort();
    const response = await responsePromise;
    await response.text();
    expect(controller.interruptActiveTurn).toHaveBeenCalled();
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
        chatkit_state: {},
      }),
    });

    const body = await response.text();

    expect(body).toContain('"type":"response.failed"');
    expect(body).toContain("stream failed");
    expect(appLoggerMock.error).toHaveBeenCalledWith(
      "Codex ChatKit stream producer failed",
      {
        attrs: {
          scope: "chatkit.codex_fetch",
          error: "Error: stream failed",
        },
      },
    );
  });
});
