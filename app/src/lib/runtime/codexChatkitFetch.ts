import {
  getCodexConversationController,
  type CodexConversationItem,
} from "./codexConversationController";
import { appLogger } from "../logging/runtime";
import type {
  ChatKitThreadDetail,
  ChatKitThreadSummary,
} from "./chatkitProtocol";
import { createChatKitFetchFromAdapter } from "./createChatKitFetchFromAdapter";
import type {
  HarnessChatKitAdapter,
  HarnessChatKitEventSink,
  HarnessChatKitMessageRequest,
  HarnessChatKitToolResultRequest,
} from "./harnessChatKitAdapter";

function toChatKitThreadItems(
  threadId: string,
  items: CodexConversationItem[],
): Record<string, unknown>[] {
  const converted: Record<string, unknown>[] = [];
  for (const item of items) {
    const createdAt = item.createdAt ?? new Date().toISOString();
    if (item.role === "user") {
      converted.push({
        id: item.id,
        type: "user_message",
        thread_id: threadId,
        created_at: createdAt,
        content: item.content.map((part) => ({
          type: "input_text",
          text: part.text,
        })),
        attachments: [],
        inference_options: {},
      });
      continue;
    }

    const assistantText = item.content.map((part) => part.text).join("");
    converted.push({
      id: item.id,
      type: "assistant_message",
      thread_id: threadId,
      created_at: createdAt,
      status: item.status,
      content: [
        {
          type: "output_text",
          text: assistantText,
          annotations: [],
        },
      ],
    });
    if (item.status === "completed") {
      converted.push({
        id: `${item.id}-end-of-turn`,
        type: "end_of_turn",
        thread_id: threadId,
        created_at: createdAt,
      });
    }
  }
  return converted;
}

function createCodexStreamId(): string {
  return `codex-stream-${Math.random().toString(36).slice(2, 10)}`;
}

export function createCodexChatKitAdapter(
  controller: ReturnType<typeof getCodexConversationController> = getCodexConversationController(),
): HarnessChatKitAdapter {
  return {
    get initialThreadId(): string | undefined {
      return controller.getSnapshot().currentThreadId ?? undefined;
    },
    historyEnabled: false,
    async onThreadSelected(threadId: string | null): Promise<void> {
      if (!threadId) {
        controller.startNewChat();
        return;
      }
      await controller.selectThread(threadId);
    },
    async onNewConversation(): Promise<string | null> {
      controller.startNewChat();
      const thread = await controller.ensureActiveThread();
      return thread.id;
    },
    async listThreads(): Promise<ChatKitThreadSummary[]> {
      await controller.refreshHistory();
      return controller.getSnapshot().threads.map((thread) => ({
        id: thread.id,
        title: thread.title,
        updated_at: thread.updatedAt,
      }));
    },
    async getThread(threadId: string): Promise<ChatKitThreadDetail> {
      const thread = await controller.getThread(threadId);
      const messageCollection = {
        data: toChatKitThreadItems(threadId, thread.items),
        has_more: false,
      };
      return {
        id: thread.id,
        title: thread.title,
        created_at: thread.updatedAt ?? new Date().toISOString(),
        status: { type: "active" },
        metadata: {},
        updated_at: thread.updatedAt,
        items: messageCollection,
        messages: messageCollection,
      };
    },
    async listItems(threadId: string): Promise<Record<string, unknown>[]> {
      const payload = await controller.handleListItems(threadId);
      return toChatKitThreadItems(threadId, payload.data);
    },
    async streamUserMessage(
      request: HarnessChatKitMessageRequest,
      sink: HarnessChatKitEventSink,
    ): Promise<void> {
      if (
        request.threadId &&
        controller.getSnapshot().currentThreadId !== request.threadId
      ) {
        await controller.selectThread(request.threadId);
      }
      await controller.streamUserMessage(
        request.input,
        sink,
        request.model,
      );
    },
    async submitToolResult(
      _request: HarnessChatKitToolResultRequest,
      _sink: HarnessChatKitEventSink,
    ): Promise<void> {
      throw new Error("Codex ChatKit adapter does not accept client tool output");
    },
  };
}

export function createCodexChatkitFetch(): typeof fetch {
  return createChatKitFetchFromAdapter(
    createCodexChatKitAdapter(),
    buildCodexChatKitFetchOptions(),
  );
}

export function buildCodexChatKitFetchOptions(): Parameters<
  typeof createChatKitFetchFromAdapter
>[1] {
  return {
    unsupportedRequestPrefix: "unsupported_codex_chatkit_request",
    onUnsupportedRequest: (requestType, payload) => {
      appLogger.error("Unsupported Codex ChatKit fetch request", {
        attrs: {
          scope: "chatkit.codex_adapter",
          requestType: requestType ?? null,
          payload,
        },
      });
    },
    onAbort: async () => {
      await getCodexConversationController().interruptActiveTurn();
    },
    streamLog: {
      scope: "chatkit.codex_fetch",
      createStreamId: createCodexStreamId,
      buildContext: async (request) => {
        if (request.type !== "threads.add_user_message") {
          return {};
        }
        const activeThread = await getCodexConversationController().ensureActiveThread(
          request.model,
        );
        return {
          requestType: request.requestTypeLabel,
          inputText: request.input,
          threadId: request.threadId ?? activeThread.id,
          previousResponseId: null,
        };
      },
      producerFailedMessage: "Codex ChatKit stream producer failed",
      abortMessages: {
        signaled: "Codex ChatKit stream abort signaled",
        completed: "Codex ChatKit stream abort handler completed",
        ignored: "Codex ChatKit stream abort ignored after stream settled",
      },
    },
  };
}
