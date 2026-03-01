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

describe("CodexConversationController", () => {
  beforeEach(() => {
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
});
