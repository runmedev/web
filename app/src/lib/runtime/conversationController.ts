import { useEffect, useState } from "react";
import type { ChatKitStreamEvent } from "./chatkitProtocol";

export type ConversationThreadSummary = {
  id: string;
  title: string;
  updatedAt?: string;
};

export type ConversationProjectSummary = {
  id: string;
  name: string;
};

export type ConversationControllerSnapshot = {
  currentThreadId: string | null;
  currentTurnId?: string | null;
  threads: ConversationThreadSummary[];
  loadingHistory: boolean;
  historyError: string | null;
  selectedModel: string;
  selectedProject?: ConversationProjectSummary | null;
};

export type ConversationThreadDetail = {
  id: string;
  title: string;
  updatedAt?: string;
  items: unknown[];
};

export type ConversationStreamSink = {
  emit(event: ChatKitStreamEvent): void;
};

export type ConversationStreamResult = {
  threadId: string;
  previousResponseId: string;
};

export interface ConversationController {
  getSnapshot(): ConversationControllerSnapshot;
  subscribe(listener: () => void): () => void;
  refreshHistory(): Promise<void>;
  newChat(): void | Promise<void>;
  selectThread(threadId: string): Promise<ConversationThreadDetail>;
  getThread(threadId: string): Promise<ConversationThreadDetail>;
  listItems(threadId: string): Promise<unknown[]>;
  streamUserMessage(
    input: string,
    sink: ConversationStreamSink,
    modelOverride?: string,
    signal?: AbortSignal | null,
  ): Promise<ConversationStreamResult | void>;
  setSelectedModel(model: string): void;
  setSelectedProject?(projectId: string): void | Promise<void>;
}

export function useConversationControllerSnapshot(
  controller: ConversationController | null,
): ConversationControllerSnapshot | null {
  const [snapshot, setSnapshot] = useState<ConversationControllerSnapshot | null>(() =>
    controller ? controller.getSnapshot() : null,
  );

  useEffect(() => {
    if (!controller) {
      setSnapshot(null);
      return;
    }
    setSnapshot(controller.getSnapshot());
    return controller.subscribe(() => {
      setSnapshot(controller.getSnapshot());
    });
  }, [controller]);

  return snapshot;
}
