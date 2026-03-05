// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ChatKitAssistantMessageItem,
  ChatKitStreamEvent,
} from "./chatkitProtocol";
import { createCodexConversationControllerForTests } from "./codexConversationController";

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

const project = {
  id: "project-1",
  name: "Runme Repo",
  cwd: "/workspace",
  model: "gpt-5",
  approvalPolicy: "never",
  sandboxPolicy: "workspace-write",
  personality: "pragmatic",
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

type RenderState = {
  responses: Map<string, ChatKitAssistantMessageItem>;
  order: string[];
};

function reduceEvents(events: ChatKitStreamEvent[]): RenderState {
  const state: RenderState = {
    responses: new Map(),
    order: [],
  };

  for (const event of events) {
    switch (event.type) {
      case "thread.item.added": {
        state.responses.set(event.item.id, {
          ...event.item,
          content: [...event.item.content],
        });
        state.order.push(event.item.id);
        break;
      }
      case "thread.item.updated": {
        const item = state.responses.get(event.item_id);
        if (!item) {
          break;
        }
        switch (event.update.type) {
          case "assistant_message.content_part.added":
            item.content = [
              {
                type: "output_text",
                text: event.update.content.text,
                annotations: [...event.update.content.annotations],
              },
            ];
            break;
          case "assistant_message.content_part.text_delta": {
            const current = item.content[0]?.text ?? "";
            item.content = [
              { type: "output_text", text: `${current}${event.update.delta}` },
            ];
            break;
          }
          case "assistant_message.content_part.done":
            item.content = [
              {
                type: "output_text",
                text: event.update.content.text,
                annotations: [...event.update.content.annotations],
              },
            ];
            item.status = "completed";
            break;
        }
        break;
      }
      case "thread.item.done": {
        if (event.item.type !== "assistant_message") {
          break;
        }
        state.responses.set(event.item.id, {
          ...event.item,
          content: [...event.item.content],
        });
        if (!state.order.includes(event.item.id)) {
          state.order.push(event.item.id);
        }
        break;
      }
      default:
        break;
    }
  }

  return state;
}

function ContractRenderer({ events }: { events: ChatKitStreamEvent[] }) {
  const state = reduceEvents(events);
  return (
    <div>
      {state.order.map((itemId) => {
        const item = state.responses.get(itemId);
        if (!item) {
          return null;
        }
        return (
          <article key={itemId} data-testid={`assistant-item-${itemId}`}>
            {item.content[0]?.text ?? ""}
          </article>
        );
      })}
    </div>
  );
}

describe("ChatKit protocol render contract", () => {
  beforeEach(() => {
    proxyClient.sendRequest.mockReset();
    proxyClient.subscribeNotifications.mockClear();
    notificationHandlers.clear();
  });

  it("renders the assistant text produced by the codex conversation stream", async () => {
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
    const events: ChatKitStreamEvent[] = [];
    await controller.streamUserMessage("print hello world in python", {}, {
      emit: (payload) => events.push(payload),
    });

    render(<ContractRenderer events={events} />);

    expect(screen.getByTestId("assistant-item-msg-1").textContent).toBe(
      '[[CODEX_STREAM_START]]\nprint("Hello, world!")\n[[CODEX_STREAM_END]]',
    );
  });
});
