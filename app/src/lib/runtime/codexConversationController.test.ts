import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RUNME_CODEX_WASM_DEVELOPER_INSTRUCTIONS } from "./runmeChatkitPrompts";

const project = {
  id: "project-1",
  name: "Runme Repo",
  cwd: "/workspace",
  model: "gpt-5.4",
  approvalPolicy: "never",
  sandboxPolicy: "workspace-write",
  personality: "pragmatic",
};

const notificationHandlers = new Set<(notification: any) => void>();
const proxyClient = {
  sendRequest: vi.fn(),
  getTransport: vi.fn(() => "proxy"),
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

vi.mock("./codexAppServerClient", () => ({
  getCodexAppServerClient: () => proxyClient,
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
  const defaultResponseId =
    (
      events.findLast(
        (event) => event.type === "response.completed",
      )?.response as { id?: string } | undefined
    )?.id;
  const rawResponseCreatedIds = new Set(
    events
      .filter((event) => event.type === "response.created")
      .map((event) => (event.response as { id?: string } | undefined)?.id)
      .filter((id): id is string => Boolean(id)),
  );
  const rawOutputItemAddedIds = new Set(
    events
      .filter((event) => event.type === "response.output_item.added")
      .map((event) => {
        const item = event.item as { id?: string } | undefined;
        return (typeof event.item_id === "string" ? event.item_id : item?.id) ?? null;
      })
      .filter((id): id is string => Boolean(id)),
  );
  const rawContentPartAddedIds = new Set(
    events
      .filter((event) => event.type === "response.content_part.added")
      .map((event) => {
        const partItemId =
          typeof event.item_id === "string"
            ? event.item_id
            : ((event.item as { id?: string } | undefined)?.id ?? null);
        return partItemId;
      })
      .filter((id): id is string => Boolean(id)),
  );
  const hasRawOutputTextDeltas = events.some(
    (event) => event.type === "response.output_text.delta",
  );
  const rawOutputTextDoneIds = new Set(
    events
      .filter((event) => event.type === "response.output_text.done")
      .map((event) => (typeof event.item_id === "string" ? event.item_id : null))
      .filter((id): id is string => Boolean(id)),
  );
  const rawContentPartDoneIds = new Set(
    events
      .filter((event) => event.type === "response.content_part.done")
      .map((event) => (typeof event.item_id === "string" ? event.item_id : null))
      .filter((id): id is string => Boolean(id)),
  );
  const rawOutputItemDoneIds = new Set(
    events
      .filter((event) => event.type === "response.output_item.done")
      .map((event) => {
        const item = event.item as { id?: string } | undefined;
        return (typeof event.item_id === "string" ? event.item_id : item?.id) ?? null;
      })
      .filter((id): id is string => Boolean(id)),
  );
  let responseCreated = false;
  const normalized = events.flatMap((event) => {
    switch (event.type) {
      case "thread.item.added": {
        if ((event.item as { type?: string } | undefined)?.type !== "assistant_message") {
          return [];
        }
        const itemId = (event.item as { id?: string } | undefined)?.id;
        const normalized: Array<Record<string, unknown>> = [];
        if (
          defaultResponseId &&
          !responseCreated &&
          !rawResponseCreatedIds.has(defaultResponseId)
        ) {
          responseCreated = true;
          normalized.push({
            type: "response.created",
            response_id: defaultResponseId,
          });
        }
        if (defaultResponseId && itemId && !rawOutputItemAddedIds.has(itemId)) {
          normalized.push({
            type: "response.output_item.added",
            response_id: defaultResponseId,
            item_id: itemId,
          });
        }
        if (defaultResponseId && itemId && !rawContentPartAddedIds.has(itemId)) {
          normalized.push({
            type: "response.content_part.added",
            response_id: defaultResponseId,
            item_id: itemId,
            text:
              (
                event.item as { content?: Array<{ text?: string }> } | undefined
              )?.content?.[0]?.text ?? "",
          });
        }
        return normalized;
      }
      case "thread.item.updated":
        switch ((event.update as { type?: string } | undefined)?.type) {
          case "assistant_message.content_part.text_delta":
            if (hasRawOutputTextDeltas) {
              return [];
            }
            return [
              {
                type: "response.output_text.delta",
                response_id: defaultResponseId,
                item_id: event.item_id,
                delta: (event.update as { delta?: string } | undefined)?.delta,
              },
            ];
          case "assistant_message.content_part.done":
            return [
              !rawOutputTextDoneIds.has(String(event.item_id)) && {
                type: "response.output_text.done",
                response_id: defaultResponseId,
                item_id: event.item_id,
                text:
                  (
                    event.update as {
                      content?: { text?: string };
                    } | undefined
                  )?.content?.text ?? "",
              },
              !rawContentPartDoneIds.has(String(event.item_id)) && {
                type: "response.content_part.done",
                response_id: defaultResponseId,
                item_id: event.item_id,
                text:
                  (
                    event.update as {
                      content?: { text?: string };
                    } | undefined
                  )?.content?.text ?? "",
              },
            ].filter(Boolean);
          default:
            return [];
        }
      case "thread.item.done":
        if ((event.item as { type?: string } | undefined)?.type !== "assistant_message") {
          return [];
        }
        if (rawOutputItemDoneIds.has((event.item as { id?: string } | undefined)?.id ?? "")) {
          return [];
        }
        return [
          {
            type: "response.output_item.done",
            response_id: defaultResponseId,
            item_id: (event.item as { id?: string } | undefined)?.id,
            text:
              (
                event.item as { content?: Array<{ text?: string }> } | undefined
              )?.content?.[0]?.text ?? "",
          },
        ];
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
              (
                event.item as { content?: Array<{ text?: string }> } | undefined
              )?.content?.[0]?.text ?? "",
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
  const deduped: Array<Record<string, unknown>> = [];
  let previousKey: string | null = null;
  normalized.forEach((event) => {
    const key = JSON.stringify(event);
    if (key === previousKey) {
      return;
    }
    deduped.push(event);
    previousKey = key;
  });
  return deduped;
}

function normalizeExpectedFixtureEvents(
  events: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return events.filter((event) => event.type !== "aisre.chatkit.state");
}

describe("CodexConversationController", () => {
  beforeEach(() => {
    vi.useRealTimers();
    proxyClient.sendRequest.mockReset();
    proxyClient.getTransport.mockReset();
    proxyClient.getTransport.mockReturnValue("proxy");
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

  it("does not send project cwd when refreshing history in wasm mode", async () => {
    proxyClient.getTransport.mockReturnValue("wasm");
    proxyClient.sendRequest.mockResolvedValueOnce({
      threads: [{ id: "thread-1", title: "One", last_turn_id: "turn-1" }],
    });

    const controller = createCodexConversationControllerForTests();
    await controller.refreshHistory();

    expect(proxyClient.sendRequest).toHaveBeenCalledWith("thread/list", undefined);
    expect(controller.getSnapshot().threads).toEqual([
      expect.objectContaining({
        id: "thread-1",
        title: "One",
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

    expect(proxyClient.sendRequest).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({
        projectId: "project-1",
        cwd: "/workspace",
        model: "gpt-5.4",
        approvalPolicy: "never",
        sandboxPolicy: "workspace-write",
        personality: "pragmatic",
        developerInstructions: RUNME_CODEX_WASM_DEVELOPER_INSTRUCTIONS,
      }),
    );
    expect(thread).toEqual(
      expect.objectContaining({
        id: "thread-bootstrap",
        title: "Bootstrap Thread",
        cwd: "/workspace",
      }),
    );
    expect(controller.getSnapshot().currentThreadId).toBe("thread-bootstrap");
  });

  it("omits project cwd when creating a thread in wasm mode", async () => {
    proxyClient.getTransport.mockReturnValue("wasm");
    proxyClient.sendRequest.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        return {
          thread: {
            id: "thread-bootstrap",
            title: "Bootstrap Thread",
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const controller = createCodexConversationControllerForTests();
    const thread = await controller.ensureActiveThread();

    expect(proxyClient.sendRequest).toHaveBeenCalledWith(
      "thread/start",
      expect.not.objectContaining({
        cwd: expect.anything(),
      }),
    );
    expect(proxyClient.sendRequest).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({
        projectId: "project-1",
        model: "gpt-5.4",
        approvalPolicy: "never",
        sandboxPolicy: "workspace-write",
        personality: "pragmatic",
        developerInstructions: RUNME_CODEX_WASM_DEVELOPER_INSTRUCTIONS,
      }),
    );
    expect(thread).toEqual(
      expect.objectContaining({
        id: "thread-bootstrap",
        title: "Bootstrap Thread",
        cwd: "/workspace",
      }),
    );
  });

  it("uses a per-request model override for thread start and turn start", async () => {
    proxyClient.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "thread/start") {
        expect(params).toEqual(
          expect.objectContaining({
            model: "gpt-5.4",
          }),
        );
        return {
          thread: {
            id: "thread-override",
            title: "Override Thread",
            cwd: "/workspace",
          },
        };
      }
      if (method === "turn/start") {
        expect(params).toEqual(
          expect.objectContaining({
            threadId: "thread-override",
            model: "gpt-5.4",
          }),
        );
        queueMicrotask(() => {
          notificationHandlers.forEach((handler) => {
            handler({
              jsonrpc: "2.0",
              method: "turn/completed",
              params: {
                threadId: "thread-override",
                turnId: "turn-override",
              },
            });
          });
        });
        return { turnId: "turn-override" };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const controller = createCodexConversationControllerForTests();
    const events: any[] = [];
    await controller.streamUserMessage("hello", { emit: (payload) => events.push(payload) }, "gpt-5.4");

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "thread.item.added",
          item: expect.objectContaining({
            inference_options: {
              model: "gpt-5.4",
            },
          }),
        }),
      ]),
    );
  });

  it("does not treat previousResponseId as an active turn id when creating/selecting threads", async () => {
    proxyClient.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "thread/start") {
        return {
          thread: {
            id: "thread-bootstrap",
            title: "Bootstrap Thread",
            cwd: "/workspace",
            previous_response_id: "resp-old",
          },
        };
      }
      if (method === "thread/read") {
        expect(params).toEqual({ threadId: "thread-1" });
        return {
          thread: {
            id: "thread-1",
            title: "One",
            cwd: "/workspace",
            previous_response_id: "resp-older",
            items: [],
          },
        };
      }
      if (method === "turn/interrupt") {
        return {};
      }
      throw new Error(`unexpected method ${method}`);
    });

    const controller = createCodexConversationControllerForTests();
    await controller.ensureActiveThread();
    expect(controller.getSnapshot().currentTurnId).toBeNull();

    await controller.selectThread("thread-1");
    expect(controller.getSnapshot().currentTurnId).toBeNull();

    await controller.interruptActiveTurn();
    expect(proxyClient.sendRequest).not.toHaveBeenCalledWith(
      "turn/interrupt",
      expect.anything(),
    );
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
          type: "thread.item.updated",
          item_id: "msg-1",
          update: expect.objectContaining({
            type: "assistant_message.content_part.text_delta",
            delta: "hello ",
          }),
        }),
        expect.objectContaining({
          type: "thread.item.updated",
          item_id: "msg-2",
          update: expect.objectContaining({
            type: "assistant_message.content_part.text_delta",
            delta: "done",
          }),
        }),
        expect.objectContaining({
          type: "thread.item.done",
          item: expect.objectContaining({
            id: "msg-2",
            type: "assistant_message",
            status: "completed",
          }),
        }),
        expect.objectContaining({
          type: "response.completed",
        }),
      ]),
    );
    expect(
      events.filter((event) => event?.type === "response.completed"),
    ).toHaveLength(2);
    expect(controller.getSnapshot().currentThreadId).toBe("thread-1");
    expect(controller.getSnapshot().currentTurnId).toBeNull();
  });

  it("ignores a stale ChatKit thread id when the controller already has a current thread", async () => {
    proxyClient.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "thread/start") {
        return { threadId: "thread-fresh", title: "Runme Repo" };
      }
      if (method === "turn/start") {
        expect(params).toEqual(
          expect.objectContaining({
            threadId: "thread-fresh",
          }),
        );
        queueMicrotask(() => {
          notificationHandlers.forEach((handler) => {
            handler({
              jsonrpc: "2.0",
              method: "turn.message.started",
              params: {
                threadId: "thread-fresh",
                turnId: "turn-1",
                responseId: "resp-1",
                itemId: "msg-1",
              },
            });
            handler({
              jsonrpc: "2.0",
              method: "turn.output_text.done",
              params: {
                threadId: "thread-fresh",
                turnId: "turn-1",
                responseId: "resp-1",
                itemId: "msg-1",
                text: "done",
              },
            });
            handler({
              jsonrpc: "2.0",
              method: "turn.completed",
              params: {
                threadId: "thread-fresh",
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
      "hello",
      {
        emit: (payload) => events.push(payload),
      },
    );

    expect(nextState).toEqual({
      threadId: "thread-fresh",
      previousResponseId: "resp-1",
    });
    expect(controller.getSnapshot().currentThreadId).toBe("thread-fresh");
  });

  it("resumes threads with Runme developer instructions", async () => {
    proxyClient.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "thread/read") {
        expect(params).toEqual({ threadId: "thread-1" });
        return {
          thread: {
            id: "thread-1",
            title: "Existing Thread",
            cwd: "/workspace",
            turns: [],
          },
        };
      }
      if (method === "thread/resume") {
        expect(params).toEqual(
          expect.objectContaining({
            threadId: "thread-1",
            cwd: "/workspace",
            developerInstructions: RUNME_CODEX_WASM_DEVELOPER_INSTRUCTIONS,
          }),
        );
        return { thread: { id: "thread-1" } };
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          notificationHandlers.forEach((handler) => {
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
        return { turnId: "turn-1" };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const controller = createCodexConversationControllerForTests();
    await controller.selectThread("thread-1");
    await controller.streamUserMessage("hello", { emit: vi.fn() });
  });

  it("omits project cwd when resuming a thread in wasm mode", async () => {
    proxyClient.getTransport.mockReturnValue("wasm");
    proxyClient.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "thread/read") {
        return {
          thread: {
            id: "thread-1",
            title: "Existing Thread",
            cwd: "/workspace",
            turns: [],
          },
        };
      }
      if (method === "thread/resume") {
        expect(params).toEqual(
          expect.objectContaining({
            threadId: "thread-1",
            developerInstructions: RUNME_CODEX_WASM_DEVELOPER_INSTRUCTIONS,
          }),
        );
        expect(params).toEqual(
          expect.not.objectContaining({
            cwd: expect.anything(),
          }),
        );
        return { thread: { id: "thread-1" } };
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          notificationHandlers.forEach((handler) => {
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
        return { turnId: "turn-1" };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const controller = createCodexConversationControllerForTests();
    await controller.selectThread("thread-1");
    await controller.streamUserMessage("hello", { emit: vi.fn() });
  });

  it("uses a per-request model override when resuming an existing thread", async () => {
    proxyClient.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "thread/read") {
        return {
          thread: {
            id: "thread-1",
            title: "Existing Thread",
            cwd: "/workspace",
            turns: [],
          },
        };
      }
      if (method === "thread/resume") {
        expect(params).toEqual(
          expect.objectContaining({
            threadId: "thread-1",
            model: "gpt-5.4",
          }),
        );
        return { thread: { id: "thread-1" } };
      }
      if (method === "turn/start") {
        expect(params).toEqual(
          expect.objectContaining({
            threadId: "thread-1",
            model: "gpt-5.4",
          }),
        );
        queueMicrotask(() => {
          notificationHandlers.forEach((handler) => {
            handler({
              jsonrpc: "2.0",
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
              },
            });
          });
        });
        return { turnId: "turn-1" };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const controller = createCodexConversationControllerForTests();
    await controller.selectThread("thread-1");
    await controller.streamUserMessage("hello", { emit: vi.fn() }, "gpt-5.4");
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
        expect.objectContaining({
          type: "thread.item.updated",
          item_id: "msg-1",
          update: expect.objectContaining({
            type: "assistant_message.content_part.text_delta",
            delta: "hello ",
          }),
        }),
        expect.objectContaining({
          type: "thread.item.done",
          item: expect.objectContaining({
            id: "msg-1",
            type: "assistant_message",
            status: "completed",
            content: [expect.objectContaining({ text: "hello world" })],
          }),
        }),
        expect.objectContaining({ type: "response.completed" }),
      ]),
    );
    expect(controller.getSnapshot().currentThreadId).toBe("thread-1");
  });

  it("keeps rendering assistant output when a single turn emits multiple assistant messages", async () => {
    proxyClient.sendRequest.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        return {
          thread: {
            id: "thread-1",
            title: "Runme Repo",
            cwd: "/workspace",
          },
        };
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          notificationHandlers.forEach((handler) => {
            handler({
              jsonrpc: "2.0",
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "msg-1",
                delta: "I'll inspect the notebook cells to summarize its purpose.",
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
                  text: "I'll inspect the notebook cells to summarize its purpose.",
                },
              },
            });
            handler({
              jsonrpc: "2.0",
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "msg-2",
                delta: "It's a minimal Runme notebook for configuring and using a local Codex instance.",
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
                  id: "msg-2",
                  text: "It's a minimal Runme notebook for configuring and using a local Codex instance.",
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
      "What is this notebook about",
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
        expect.objectContaining({
          type: "thread.item.done",
          item: expect.objectContaining({
            id: "msg-1",
            content: [
              expect.objectContaining({
                text: "I'll inspect the notebook cells to summarize its purpose.",
              }),
            ],
          }),
        }),
        expect.objectContaining({
          type: "thread.item.done",
          item: expect.objectContaining({
            id: "msg-2",
            content: [
              expect.objectContaining({
                text: "It's a minimal Runme notebook for configuring and using a local Codex instance.",
              }),
            ],
          }),
        }),
        expect.objectContaining({
          type: "thread.item.done",
          item: expect.objectContaining({ id: "msg-1" }),
        }),
        expect.objectContaining({
          type: "thread.item.done",
          item: expect.objectContaining({ id: "msg-2" }),
        }),
      ]),
    );
    expect(
      events.filter((event) => event?.type === "response.completed"),
    ).toEqual([
      expect.objectContaining({
        type: "response.completed",
        response: expect.objectContaining({ id: "turn-1" }),
      }),
    ]);

    const thread = controller
      .getSnapshot()
      .threads.find((item) => item.id === "thread-1");
    const assistantItems = thread?.items.filter((item) => item.role === "assistant") ?? [];
    expect(assistantItems).toHaveLength(2);
    expect(assistantItems.at(0)?.content[0]?.text).toBe(
      "I'll inspect the notebook cells to summarize its purpose.",
    );
    expect(assistantItems.at(1)?.content[0]?.text).toBe(
      "It's a minimal Runme notebook for configuring and using a local Codex instance.",
    );
  });

  it("keeps the assistant item in progress until turn completion", async () => {
    let emitNotifications: (() => void) | null = null;
    let emitTurnCompleted: (() => void) | null = null;
    proxyClient.sendRequest.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        return {
          thread: {
            id: "thread-1",
            title: "Runme Repo",
            cwd: "/workspace",
          },
        };
      }
      if (method === "turn/start") {
        emitNotifications = () => {
          notificationHandlers.forEach((handler) => {
            handler({
              jsonrpc: "2.0",
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "msg-1",
                delta: "I'll inspect the notebook cells to summarize its purpose.",
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
                  text: "I'll inspect the notebook cells to summarize its purpose.",
                },
              },
            });
          });
        };
        emitTurnCompleted = () => {
          notificationHandlers.forEach((handler) => {
            handler({
              jsonrpc: "2.0",
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: { id: "turn-1", status: "completed" },
              },
            });
          });
        };
        return { turn: { id: "turn-1", status: "inProgress" } };
      }
      return {};
    });

    const controller = createCodexConversationControllerForTests();
    const events: any[] = [];
    const streamPromise = controller.streamUserMessage("What is this notebook about", {
      emit: (payload) => events.push(payload),
    });

    for (let attempt = 0; attempt < 5 && !emitNotifications; attempt += 1) {
      await Promise.resolve();
    }
    expect(emitNotifications).toBeTypeOf("function");
    emitNotifications?.();
    await Promise.resolve();

    const threadBeforeCompletion = controller
      .getSnapshot()
      .threads.find((item) => item.id === "thread-1");
    const assistantBeforeCompletion = threadBeforeCompletion?.items.find(
      (item) => item.id === "msg-1",
    );
    expect(assistantBeforeCompletion).toEqual(
      expect.objectContaining({
        id: "msg-1",
        status: "in_progress",
        content: [
          expect.objectContaining({
            text: "I'll inspect the notebook cells to summarize its purpose.",
          }),
        ],
      }),
    );
    expect(
      events.filter(
        (event) => event?.type === "thread.item.done" && event?.item?.id === "msg-1",
      ),
    ).toHaveLength(0);

    emitTurnCompleted?.();
    await streamPromise;

    expect(
      events.filter(
        (event) => event?.type === "thread.item.done" && event?.item?.id === "msg-1",
      ),
    ).toHaveLength(1);
  });

  it("backfills assistant output from thread/read when turn completion arrives without item notifications", async () => {
    proxyClient.sendRequest.mockImplementation(
      async (method: string, params?: Record<string, unknown>) => {
        if (method === "thread/start") {
          return {
            thread: {
              id: "thread-1",
              title: "Runme Repo",
              cwd: "/workspace",
            },
          };
        }
        if (method === "turn/start") {
          queueMicrotask(() => {
            notificationHandlers.forEach((handler) => {
              handler({
                jsonrpc: "2.0",
                method: "turn/completed",
                params: {
                  threadId: "thread-1",
                  turn: {
                    id: "turn-1",
                    status: "completed",
                    items: [],
                  },
                },
              });
            });
          });
          return { turn: { id: "turn-1", status: "inProgress", items: [] } };
        }
        if (
          method === "thread/read" &&
          params?.threadId === "thread-1" &&
          params?.includeTurns === true
        ) {
          return {
            thread: {
              id: "thread-1",
              title: "Runme Repo",
              turns: [
                {
                  id: "turn-1",
                  items: [
                    {
                      id: "msg-1",
                      type: "agentMessage",
                      text: "Bonjour. Oui, je peux parler francais.",
                    },
                  ],
                },
              ],
            },
          };
        }
        return {};
      },
    );

    const controller = createCodexConversationControllerForTests();
    const events: any[] = [];
    const nextState = await controller.streamUserMessage(
      "Can you speak french?",
      {
        emit: (payload) => events.push(payload),
      },
    );

    expect(nextState).toEqual({
      threadId: "thread-1",
      previousResponseId: "turn-1",
    });
    expect(proxyClient.sendRequest).toHaveBeenCalledWith("thread/read", {
      threadId: "thread-1",
      includeTurns: true,
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "thread.item.done",
          item: expect.objectContaining({
            id: "msg-1",
            content: [
              expect.objectContaining({
                text: "Bonjour. Oui, je peux parler francais.",
              }),
            ],
          }),
        }),
        expect.objectContaining({
          type: "response.completed",
          response: expect.objectContaining({ id: "turn-1" }),
        }),
      ]),
    );
  });

  it("emits user and assistant thread items for the streamed assistant text", async () => {
    proxyClient.sendRequest.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        return { threadId: "thread-1", title: "Runme Repo" };
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          notificationHandlers.forEach((handler) => {
            handler({
              jsonrpc: "2.0",
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "msg-1",
                delta: 'print("Hello, world!")',
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
                  text: 'print("Hello, world!")',
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
    await controller.streamUserMessage("print hello world in python", {
      emit: (payload) => events.push(payload),
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "response.created",
          response: expect.objectContaining({
            id: "turn-1",
          }),
        }),
        expect.objectContaining({
          type: "thread.item.added",
          item: expect.objectContaining({
            type: "user_message",
            content: [
              expect.objectContaining({
                type: "input_text",
                text: "print hello world in python",
              }),
            ],
            attachments: [],
            inference_options: expect.objectContaining({
              model: "gpt-5.4",
            }),
          }),
        }),
        expect.objectContaining({
          type: "thread.item.done",
          item: expect.objectContaining({
            type: "user_message",
            content: [
              expect.objectContaining({
                type: "input_text",
                text: "print hello world in python",
              }),
            ],
          }),
        }),
        expect.objectContaining({
          type: "response.output_item.added",
          response_id: "turn-1",
          item: expect.objectContaining({
            id: "msg-1",
            type: "message",
            role: "assistant",
            status: "in_progress",
          }),
        }),
        expect.objectContaining({
          type: "thread.item.added",
          item: expect.objectContaining({
            id: "msg-1",
            type: "assistant_message",
            status: "in_progress",
          }),
        }),
        expect.objectContaining({
          type: "response.output_text.delta",
          response_id: "turn-1",
          item_id: "msg-1",
          delta: 'print("Hello, world!")',
        }),
        expect.objectContaining({
          type: "thread.item.updated",
          item_id: "msg-1",
          update: expect.objectContaining({
            type: "assistant_message.content_part.added",
          }),
        }),
        expect.objectContaining({
          type: "thread.item.updated",
          item_id: "msg-1",
          update: expect.objectContaining({
            type: "assistant_message.content_part.done",
            content: expect.objectContaining({
              text: 'print("Hello, world!")',
            }),
          }),
        }),
        expect.objectContaining({
          type: "response.output_item.done",
          response_id: "turn-1",
          item: expect.objectContaining({
            id: "msg-1",
            type: "message",
            role: "assistant",
            status: "completed",
          }),
        }),
        expect.objectContaining({
          type: "thread.item.done",
          item: expect.objectContaining({
            id: "msg-1",
            type: "assistant_message",
            status: "completed",
          }),
        }),
      ]),
    );
  });

  it("surfaces commentary-phase deltas before the final answer completes", async () => {
    proxyClient.sendRequest.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        return { threadId: "thread-1", title: "Runme Repo" };
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          notificationHandlers.forEach((handler) => {
            handler({
              jsonrpc: "2.0",
              method: "item/started",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                item: {
                  id: "msg-commentary-1",
                  phase: "commentary",
                  text: "",
                  type: "agentMessage",
                },
              },
            });
            handler({
              jsonrpc: "2.0",
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "msg-commentary-1",
                delta: "I’m searching the docs first.",
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
                  id: "msg-commentary-1",
                  text: "I’m searching the docs first.",
                },
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
                  id: "msg-final-1",
                  text: "A runme runner executes notebook cells.",
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
    await controller.streamUserMessage("What is a runme runner", {
      emit: (payload) => events.push(payload),
    });

    const commentaryDeltaIndex = events.findIndex(
      (event) =>
        event?.type === "response.output_text.delta" &&
        event?.item_id === "msg-commentary-1" &&
        event?.delta === "I’m searching the docs first.",
    );
    const finalItemDoneIndex = events.findIndex(
      (event) =>
        event?.type === "response.output_item.done" &&
        event?.item?.id === "msg-final-1",
    );

    expect(commentaryDeltaIndex).toBeGreaterThanOrEqual(0);
    expect(finalItemDoneIndex).toBeGreaterThan(commentaryDeltaIndex);
  });

  it("surfaces reasoning summary deltas before assistant commentary arrives", async () => {
    proxyClient.sendRequest.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        return { threadId: "thread-1", title: "Runme Repo" };
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          notificationHandlers.forEach((handler) => {
            handler({
              jsonrpc: "2.0",
              method: "item/reasoning/summaryTextDelta",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "reasoning-1",
                delta: "I’m inspecting the Jupyter integration first.",
              },
            });
            handler({
              jsonrpc: "2.0",
              method: "item/completed",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                item: {
                  id: "reasoning-1",
                  type: "reasoning",
                  summary: [
                    {
                      type: "summary_text",
                      text: "I’m inspecting the Jupyter integration first.",
                    },
                  ],
                },
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
                  id: "msg-final-1",
                  text: "Here is the final answer.",
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
    await controller.streamUserMessage("What is a runme runner", {
      emit: (payload) => events.push(payload),
    });

    const reasoningDeltaIndex = events.findIndex(
      (event) =>
        event?.type === "response.output_text.delta" &&
        event?.item_id === "reasoning-1" &&
        event?.delta === "I’m inspecting the Jupyter integration first.",
    );
    const finalItemDoneIndex = events.findIndex(
      (event) =>
        event?.type === "response.output_item.done" &&
        event?.item?.id === "msg-final-1",
    );
    const reasoningItemAddedIndex = events.findIndex(
      (event) =>
        event?.type === "response.output_item.added" &&
        event?.item?.id === "reasoning-1",
    );

    expect(reasoningDeltaIndex).toBeGreaterThanOrEqual(0);
    expect(reasoningItemAddedIndex).toBeGreaterThanOrEqual(0);
    expect(finalItemDoneIndex).toBeGreaterThan(reasoningDeltaIndex);
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
    const promise = controller.streamUserMessage("hello", {
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
          type: "thread.item.done",
          item: expect.objectContaining({
            id: "msg-1",
            content: [expect.objectContaining({ text: "hello world" })],
          }),
        }),
        expect.objectContaining({ type: "response.completed" }),
      ]),
    );
  });

  it("prefers the real app-server assistant item over the synthetic turn fallback", async () => {
    proxyClient.sendRequest.mockImplementation(async (method: string) => {
      if (method === "thread/start") {
        return { threadId: "thread-1", title: "Runme Repo" };
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          notificationHandlers.forEach((handler) => {
            handler({
              jsonrpc: "2.0",
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "turn-1-item",
                delta: "Bonjour",
              },
            });
            handler({
              jsonrpc: "2.0",
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "msg-1",
                delta: "Bonjour",
              },
            });
            handler({
              jsonrpc: "2.0",
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "turn-1-item",
                delta: " le monde",
              },
            });
            handler({
              jsonrpc: "2.0",
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "msg-1",
                delta: " le monde",
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
                  id: "turn-1-item",
                  text: "Bonjour le monde",
                },
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
                  text: "Bonjour le monde",
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
    await controller.streamUserMessage("hello", {
      emit: (payload) => events.push(payload),
    });

    const assistantAdded = events.filter(
      (event) =>
        event?.type === "thread.item.added" &&
        event?.item?.type === "assistant_message",
    );
    const assistantDone = events.filter(
      (event) =>
        event?.type === "thread.item.done" &&
        event?.item?.type === "assistant_message",
    );
    const outputDone = events.filter(
      (event) =>
        event?.type === "thread.item.done" &&
        event?.item?.type === "assistant_message",
    );

    expect(assistantAdded).toHaveLength(1);
    expect(assistantAdded[0]?.item?.id).toBe("msg-1");
    expect(assistantDone).toHaveLength(1);
    expect(assistantDone[0]?.item?.id).toBe("msg-1");
    expect(outputDone).toHaveLength(1);
    expect(outputDone[0]?.item).toEqual(
      expect.objectContaining({
        id: "msg-1",
        content: [expect.objectContaining({ text: "Bonjour le monde" })],
      }),
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
      {
        emit: (payload) => events.push(payload as Record<string, unknown>),
      },
    );

    expect(normalizeChatKitEvents(events)).toEqual(
      normalizeExpectedFixtureEvents(expected.events),
    );

    const finalState = expected.events.findLast(
      (event) => event.type === "response.completed",
    );
    if (finalState) {
      expect(nextState.previousResponseId).toBe(finalState.response_id);
      expect(nextState.threadId).toBeTypeOf("string");
    }
  });
});
