import { beforeEach, describe, expect, it, vi } from "vitest";

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
  streamUserMessage: vi.fn(async (_input: string, _state: unknown, sink: { emit: (payload: unknown) => void }) => {
    sink.emit({ type: "response.created", response: { id: "turn-1" } });
    sink.emit({ type: "response.output_text.delta", delta: "hello" });
    sink.emit({
      type: "aisre.chatkit.state",
      item: { state: { threadId: "thread-1", previousResponseId: "turn-1" } },
    });
    sink.emit({ type: "response.completed", response: { id: "turn-1" } });
    return { threadId: "thread-1", previousResponseId: "turn-1" };
  }),
  interruptActiveTurn: vi.fn(),
};

vi.mock("./codexConversationController", () => ({
  getCodexConversationController: () => controller,
}));

import { createCodexChatkitFetch } from "./codexChatkitFetch";

describe("createCodexChatkitFetch", () => {
  beforeEach(() => {
    controller.refreshHistory.mockClear();
    controller.getSnapshot.mockClear();
    controller.getThread.mockClear();
    controller.handleListItems.mockClear();
    controller.streamUserMessage.mockClear();
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

  it("handles threads.get_by_id requests", async () => {
    const fetchFn = createCodexChatkitFetch();
    const response = await fetchFn("http://localhost/codex/app-server/ws", {
      method: "POST",
      body: JSON.stringify({ type: "threads.get_by_id", thread_id: "thread-1" }),
    });

    expect(controller.getThread).toHaveBeenCalledWith("thread-1");
    expect(await response.json()).toEqual({
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
});

