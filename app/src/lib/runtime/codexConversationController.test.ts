import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const project = {
  id: "project-1",
  name: "Runme Repo",
  cwd: "/workspace",
  model: "gpt-5",
  approvalPolicy: "never",
  sandboxPolicy: "workspace-write",
  personality: "pragmatic",
};

const notificationHandlers = new Set<(notification: any) => void>();
const proxyClient = {
  sendRequest: vi.fn(),
  subscribeNotifications: vi.fn((handler: (notification: any) => void) => {
    notificationHandlers.add(handler);
    return () => {
      notificationHandlers.delete(handler);
    };
  }),
};

const projectManager = {
  getDefaultId: vi.fn(() => project.id),
  getDefault: vi.fn(() => project),
  get: vi.fn((id: string) => (id === project.id ? project : undefined)),
  setDefault: vi.fn(),
};

vi.mock("./codexAppServerProxyClient", () => ({
  getCodexAppServerProxyClient: () => proxyClient,
}));

vi.mock("./codexProjectManager", () => ({
  getCodexProjectManager: () => projectManager,
}));

import {
  createCodexConversationControllerForTests,
} from "./codexConversationController";

type ConversationFixtureEvent = {
  kind: "request" | "response" | "notification";
  payload: Record<string, unknown>;
};

type ConversationFixture = {
  prompt: string;
  events: ConversationFixtureEvent[];
};

type ExpectedChatKitFixture = {
  events: Array<Record<string, unknown>>;
};

function loadJSONFixture<T>(...parts: string[]): T {
  const fixturePath = path.resolve(
    process.cwd(),
    "src/lib/runtime/__fixtures__",
    ...parts,
  );
  return JSON.parse(readFileSync(fixturePath, "utf8")) as T;
}

function buildConversationReplay(fixture: ConversationFixture): {
  responseQueues: Map<string, Array<Record<string, unknown>>>;
  notifications: Array<Record<string, unknown>>;
} {
  const requestMethodsById = new Map<number, string>();
  const responseQueues = new Map<string, Array<Record<string, unknown>>>();
  const notifications: Array<Record<string, unknown>> = [];

  fixture.events.forEach((event) => {
    if (event.kind === "request") {
      const id = typeof event.payload.id === "number" ? event.payload.id : null;
      const method =
        typeof event.payload.method === "string" ? event.payload.method : null;
      if (id !== null && method) {
        requestMethodsById.set(id, method);
      }
      return;
    }
    if (event.kind === "response") {
      const id = typeof event.payload.id === "number" ? event.payload.id : null;
      if (id === null) {
        return;
      }
      const method = requestMethodsById.get(id);
      if (!method) {
        throw new Error(`response fixture missing request method for id ${id}`);
      }
      const existing = responseQueues.get(method) ?? [];
      existing.push((event.payload.result as Record<string, unknown>) ?? {});
      responseQueues.set(method, existing);
      return;
    }
    notifications.push(event.payload);
  });

  return { responseQueues, notifications };
}

function normalizeChatKitEvents(
  events: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return events.flatMap((event) => {
    switch (event.type) {
      case "response.created":
        return [
          {
            type: "response.created",
            response_id: (event.response as { id?: string } | undefined)?.id,
          },
        ];
      case "response.output_item.added":
        return [
          {
            type: "response.output_item.added",
            response_id: event.response_id,
            item_id: (event.item as { id?: string } | undefined)?.id,
          },
        ];
      case "response.content_part.added":
        return [
          {
            type: "response.content_part.added",
            response_id: event.response_id,
            item_id: event.item_id,
            text: (event.part as { text?: string } | undefined)?.text ?? "",
          },
        ];
      case "response.output_text.delta":
        return [
          {
            type: "response.output_text.delta",
            response_id: event.response_id,
            item_id: event.item_id,
            delta: event.delta,
          },
        ];
      case "response.output_text.done":
        return [
          {
            type: "response.output_text.done",
            response_id: event.response_id,
            item_id: event.item_id,
            text: event.text,
          },
        ];
      case "response.content_part.done":
        return [
          {
            type: "response.content_part.done",
            response_id: event.response_id,
            item_id: event.item_id,
            text: (event.part as { text?: string } | undefined)?.text ?? "",
          },
        ];
      case "response.output_item.done":
        return [
          {
            type: "response.output_item.done",
            response_id: event.response_id,
            item_id: (event.item as { id?: string } | undefined)?.id,
            text:
              (event.item as { content?: Array<{ text?: string }> } | undefined)
                ?.content?.[0]?.text ?? "",
          },
        ];
      case "aisre.chatkit.state":
        return [
          {
            type: "aisre.chatkit.state",
            thread_id: (
              event.item as {
                state?: { threadId?: string; previousResponseId?: string };
              } | undefined
            )?.state?.threadId,
            previous_response_id: (
              event.item as {
                state?: { threadId?: string; previousResponseId?: string };
              } | undefined
            )?.state?.previousResponseId,
          },
        ];
      case "response.completed":
        return [
          {
            type: "response.completed",
            response_id: (event.response as { id?: string } | undefined)?.id,
          },
        ];
      default:
        return [];
    }
  });
}

describe("CodexConversationController", () => {
  beforeEach(() => {
    vi.useRealTimers();
    proxyClient.sendRequest.mockReset();
    proxyClient.subscribeNotifications.mockClear();
    notificationHandlers.clear();
    projectManager.setDefault.mockClear();
  });

  it("refreshes history using thread/list scoped to the selected project cwd", async () => {
    proxyClient.sendRequest.mockResolvedValueOnce({
      threads: [
        { id: "thread-1", title: "One", cwd: "/workspace", last_turn_id: "turn-1" },
      ],
    });

    const controller = createCodexConversationControllerForTests();
    await controller.refreshHistory();

    expect(proxyClient.sendRequest).toHaveBeenCalledWith("thread/list", {
      cwd: "/workspace",
    });
    expect(controller.getSnapshot().threads).toEqual([
      expect.objectContaining({
        id: "thread-1",
        title: "One",
        cwd: "/workspace",
        previousResponseId: "turn-1",
      }),
    ]);
  });

  it("ensures an active thread by creating one when no current thread exists", async () => {
    proxyClient.sendRequest.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        return {
          thread: {
            id: "thread-bootstrap",
            title: "Bootstrap Thread",
            cwd: "/workspace",
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const controller = createCodexConversationControllerForTests();
    const thread = await controller.ensureActiveThread();

    expect(proxyClient.sendRequest).toHaveBeenCalledWith("thread/start", {
      projectId: "project-1",
      cwd: "/workspace",
      model: "gpt-5",
      approvalPolicy: "never",
      sandboxPolicy: "workspace-write",
      personality: "pragmatic",
    });
    expect(thread).toEqual(
      expect.objectContaining({
        id: "thread-bootstrap",
        title: "Bootstrap Thread",
        cwd: "/workspace",
      }),
    );
    expect(controller.getSnapshot().currentThreadId).toBe("thread-bootstrap");
  });

  it("returns cached thread details when items are already present", async () => {
    proxyClient.sendRequest.mockResolvedValueOnce({
      threads: [
        { id: "thread-1", title: "One", cwd: "/workspace", last_turn_id: "turn-1" },
      ],
    });

    const controller = createCodexConversationControllerForTests();
    await controller.refreshHistory();
    const snapshot = controller.getSnapshot();
    const existing = snapshot.threads[0];
    existing.items = [
      {
        id: "msg-1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hello" }],
      },
    ];

    const detail = await controller.getThread("thread-1");

    expect(detail).toEqual(existing);
    expect(proxyClient.sendRequest).toHaveBeenCalledTimes(1);
  });

  it("streams a new codex turn into ChatKit-compatible SSE events", async () => {
    proxyClient.sendRequest.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        return { threadId: "thread-1", title: "Runme Repo" };
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          notificationHandlers.forEach((handler) => {
            handler({
              jsonrpc: "2.0",
              method: "turn.message.started",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                responseId: "resp-1",
                itemId: "msg-1",
              },
            });
            handler({
              jsonrpc: "2.0",
              method: "turn.output_text.delta",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                responseId: "resp-1",
                itemId: "msg-1",
                delta: "hello ",
              },
            });
            handler({
              jsonrpc: "2.0",
              method: "turn.output_text.done",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                responseId: "resp-1",
                itemId: "msg-1",
                text: "hello world",
              },
            });
            handler({
              jsonrpc: "2.0",
              method: "turn.message.started",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                responseId: "resp-2",
                itemId: "msg-2",
              },
            });
            handler({
              jsonrpc: "2.0",
              method: "turn.output_text.delta",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                responseId: "resp-2",
                itemId: "msg-2",
                delta: "done",
              },
            });
            handler({
              jsonrpc: "2.0",
              method: "turn.output_text.done",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                responseId: "resp-2",
                itemId: "msg-2",
                text: "done",
              },
            });
            handler({
              jsonrpc: "2.0",
              method: "turn.completed",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
              },
            });
          });
        });
        return { turnId: "turn-1", itemId: "msg-1" };
      }
      return {};
    });

    const controller = createCodexConversationControllerForTests();
    const events: any[] = [];
    const nextState = await controller.streamUserMessage(
      'print("hello")',
      {},
      {
        emit: (payload) => events.push(payload),
      },
    );

    expect(nextState).toEqual({
      threadId: "thread-1",
      previousResponseId: "resp-2",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "response.created",
        }),
        expect.objectContaining({
          type: "response.output_text.delta",
          delta: "hello ",
        }),
        expect.objectContaining({
          type: "response.output_text.delta",
          delta: "done",
        }),
        expect.objectContaining({
          type: "response.output_item.done",
        }),
        expect.objectContaining({
          type: "aisre.chatkit.state",
        }),
        expect.objectContaining({
          type: "response.completed",
        }),
      ]),
    );
    expect(
      events.filter((event) => event?.type === "response.completed"),
    ).toHaveLength(2);
    expect(
      events.filter((event) => event?.type === "aisre.chatkit.state"),
    ).toHaveLength(2);
    expect(controller.getSnapshot().currentThreadId).toBe("thread-1");
    expect(controller.getSnapshot().currentTurnId).toBeNull();
  });

  it("maps item-based codex notifications into ChatKit-compatible events", async () => {
    proxyClient.sendRequest.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        return {
          thread: {
            id: "thread-1",
            title: "Runme Repo",
            cwd: "/workspace",
            updated_at: "2026-02-26T18:00:00Z",
          },
        };
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          notificationHandlers.forEach((handler) => {
            handler({
              jsonrpc: "2.0",
              method: "turn/started",
              params: {
                threadId: "thread-1",
                turn: { id: "turn-1" },
              },
            });
            handler({
              jsonrpc: "2.0",
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "msg-1",
                delta: "hello ",
              },
            });
            handler({
              jsonrpc: "2.0",
              method: "item/completed",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                item: {
                  type: "agentMessage",
                  id: "msg-1",
                  text: "hello world",
                },
              },
            });
            handler({
              jsonrpc: "2.0",
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: { id: "turn-1", status: "completed" },
              },
            });
          });
        });
        return { turn: { id: "turn-1", status: "inProgress" } };
      }
      return {};
    });

    const controller = createCodexConversationControllerForTests();
    const events: any[] = [];
    const nextState = await controller.streamUserMessage(
      'print("hello")',
      {},
      {
        emit: (payload) => events.push(payload),
      },
    );

    expect(nextState).toEqual({
      threadId: "thread-1",
      previousResponseId: "turn-1",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "response.created" }),
        expect.objectContaining({
          type: "response.output_text.delta",
          delta: "hello ",
        }),
        expect.objectContaining({
          type: "response.output_text.done",
          text: "hello world",
        }),
        expect.objectContaining({ type: "response.completed" }),
      ]),
    );
    expect(controller.getSnapshot().currentThreadId).toBe("thread-1");
  });

  it("resets the completion timeout on inbound activity for the active turn", async () => {
    vi.useFakeTimers();
    proxyClient.sendRequest.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        return { threadId: "thread-1", title: "Runme Repo" };
      }
      if (method === "turn/start") {
        setTimeout(() => {
          notificationHandlers.forEach((handler) => {
            handler({
              jsonrpc: "2.0",
              method: "codex/event/reasoning_content_delta",
              params: {
                conversationId: "thread-1",
                id: "turn-1",
                msg: {
                  type: "reasoning_content_delta",
                  thread_id: "thread-1",
                  turn_id: "turn-1",
                  delta: "thinking",
                },
              },
            });
          });
        }, 90_000);
        setTimeout(() => {
          notificationHandlers.forEach((handler) => {
            handler({
              jsonrpc: "2.0",
              method: "item/completed",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                item: {
                  type: "agentMessage",
                  id: "msg-1",
                  text: "hello world",
                },
              },
            });
            handler({
              jsonrpc: "2.0",
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: { id: "turn-1", status: "completed" },
              },
            });
          });
        }, 170_000);
        return { turn: { id: "turn-1", status: "inProgress" } };
      }
      return {};
    });

    const controller = createCodexConversationControllerForTests();
    const events: any[] = [];
    const promise = controller.streamUserMessage("hello", {}, {
      emit: (payload) => events.push(payload),
    });

    await vi.advanceTimersByTimeAsync(170_000);
    const nextState = await promise;

    expect(nextState).toEqual({
      threadId: "thread-1",
      previousResponseId: "turn-1",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "response.output_text.done",
          text: "hello world",
        }),
        expect.objectContaining({ type: "response.completed" }),
      ]),
    );
  });

  it.each([
    {
      name: "deduplicates the real manual Codex transcript",
      inputFile: "manual-print-hello-world.input.json",
      outputFile: "manual-print-hello-world.output.json",
    },
    {
      name: "falls back to direct agent_message notifications",
      inputFile: "agent-message-only.input.json",
      outputFile: "agent-message-only.output.json",
    },
  ])("$name", async ({ inputFile, outputFile }) => {
    const fixture = loadJSONFixture<ConversationFixture>(
      "codex-chatkit",
      inputFile,
    );
    const expected = loadJSONFixture<ExpectedChatKitFixture>(
      "codex-chatkit",
      outputFile,
    );
    const { responseQueues, notifications } = buildConversationReplay(fixture);

    proxyClient.sendRequest.mockImplementation(async (method: string) => {
      const queue = responseQueues.get(method);
      if (!queue || queue.length === 0) {
        throw new Error(`unexpected method ${method}`);
      }
      const result = queue.shift() ?? {};
      if (method === "turn/start") {
        queueMicrotask(() => {
          notifications.forEach((payload) => {
            notificationHandlers.forEach((handler) => {
              handler(payload);
            });
          });
        });
      }
      return result;
    });

    const controller = createCodexConversationControllerForTests();
    const events: Array<Record<string, unknown>> = [];
    const nextState = await controller.streamUserMessage(
      fixture.prompt,
      {},
      {
        emit: (payload) => events.push(payload as Record<string, unknown>),
      },
    );

    expect(normalizeChatKitEvents(events)).toEqual(expected.events);

    const finalState = expected.events.findLast(
      (event) => event.type === "aisre.chatkit.state",
    );
    if (finalState) {
      expect(nextState).toEqual({
        threadId: finalState.thread_id,
        previousResponseId: finalState.previous_response_id,
      });
      const thread = controller
        .getSnapshot()
        .threads.find((item) => item.id === finalState.thread_id);
      const finalAssistantText = expected.events.findLast(
        (event) => event.type === "response.output_item.done",
      )?.item?.content?.[0]?.text;
      if (finalAssistantText) {
        expect(thread?.items.at(-1)?.content?.[0]?.text).toBe(finalAssistantText);
      }
    }
  });
});
