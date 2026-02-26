import { useEffect, useMemo, useState } from "react";
import { appLogger } from "../logging/runtime";
import {
  getCodexProjectManager,
  type CodexProject,
} from "./codexProjectManager";
import {
  getCodexAppServerProxyClient,
  type CodexProxyJsonRpcNotification,
} from "./codexAppServerProxyClient";

export type ChatKitStateValue = {
  threadId?: string;
  previousResponseId?: string;
};

export type CodexConversationItem = {
  id: string;
  type: "message";
  role: "user" | "assistant";
  status: "in_progress" | "completed";
  content: Array<{
    type: "input_text" | "output_text";
    text: string;
  }>;
};

export type CodexConversationThread = {
  id: string;
  title: string;
  updatedAt?: string;
  previousResponseId?: string;
  cwd?: string;
  items: CodexConversationItem[];
};

export type CodexConversationSnapshot = {
  selectedProject: CodexProject;
  threads: CodexConversationThread[];
  currentThreadId: string | null;
  currentTurnId: string | null;
  loadingHistory: boolean;
  historyError: string | null;
};

type ControllerListener = () => void;

type JsonRecord = Record<string, unknown>;

type CodexStreamSink = {
  emit: (payload: unknown) => void;
};

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as JsonRecord;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => extractText(item))
      .filter((item) => item.length > 0)
      .join("");
  }
  const record = asRecord(value);
  const direct =
    asString(record.text) ??
    asString(record.delta) ??
    asString(record.content) ??
    asString(record.preview);
  if (direct) {
    return direct;
  }
  if (Array.isArray(record.content)) {
    return record.content
      .map((item) => {
        const itemRecord = asRecord(item);
        return (
          asString(itemRecord.text) ??
          asString(itemRecord.value) ??
          asString(itemRecord.delta) ??
          ""
        );
      })
      .join("");
  }
  return "";
}

function toConversationItem(value: unknown): CodexConversationItem | null {
  const record = asRecord(value);
  const id = asString(record.id) ?? `item-${Math.random().toString(36).slice(2, 10)}`;
  const role =
    record.role === "user" || record.role === "assistant"
      ? record.role
      : "assistant";
  const status = record.status === "in_progress" ? "in_progress" : "completed";

  let content = Array.isArray(record.content)
    ? record.content
        .map((part) => {
          const partRecord = asRecord(part);
          const text = extractText(partRecord);
          if (!text) {
            return null;
          }
          const type =
            partRecord.type === "input_text" ? "input_text" : "output_text";
          return { type, text };
        })
        .filter(
          (
            item,
          ): item is {
            type: "input_text" | "output_text";
            text: string;
          } => Boolean(item),
        )
    : [];
  if (content.length === 0) {
    const text = extractText(record);
    if (!text) {
      return null;
    }
    content = [
      {
        type: role === "user" ? "input_text" : "output_text",
        text,
      },
    ];
  }

  return {
    id,
    type: "message",
    role,
    status,
    content,
  };
}

function parseThreadFromListEntry(value: unknown): CodexConversationThread | null {
  const record = asRecord(value);
  const id =
    asString(record.id) ??
    asString(record.threadId) ??
    asString(record.thread_id);
  if (!id) {
    return null;
  }
  return {
    id,
    title:
      asString(record.title) ??
      asString(record.name) ??
      asString(record.summary) ??
      "Untitled thread",
    updatedAt:
      asString(record.updatedAt) ??
      asString(record.updated_at) ??
      asString(record.lastActiveAt) ??
      asString(record.last_active_at),
    previousResponseId:
      asString(record.previousResponseId) ??
      asString(record.previous_response_id) ??
      asString(record.lastTurnId) ??
      asString(record.last_turn_id),
    cwd: asString(record.cwd),
    items: [],
  };
}

function parseThreadDetail(value: unknown): CodexConversationThread | null {
  const record = asRecord(value);
  const threadRecord =
    asRecord(record.thread).id || asRecord(record.thread).threadId
      ? asRecord(record.thread)
      : record;
  const id =
    asString(threadRecord.id) ??
    asString(threadRecord.threadId) ??
    asString(threadRecord.thread_id);
  if (!id) {
    return null;
  }

  const itemsCandidate =
    Array.isArray(threadRecord.items)
      ? threadRecord.items
      : Array.isArray(asRecord(threadRecord.items).data)
        ? (asRecord(threadRecord.items).data as unknown[])
        : Array.isArray(record.items)
          ? (record.items as unknown[])
          : Array.isArray(asRecord(record.items).data)
            ? (asRecord(record.items).data as unknown[])
            : [];

  return {
    id,
    title:
      asString(threadRecord.title) ??
      asString(threadRecord.name) ??
      "Untitled thread",
    updatedAt:
      asString(threadRecord.updatedAt) ??
      asString(threadRecord.updated_at) ??
      asString(threadRecord.lastActiveAt) ??
      asString(threadRecord.last_active_at),
    previousResponseId:
      asString(threadRecord.previousResponseId) ??
      asString(threadRecord.previous_response_id) ??
      asString(threadRecord.lastTurnId) ??
      asString(threadRecord.last_turn_id),
    cwd: asString(threadRecord.cwd),
    items: itemsCandidate
      .map((item) => toConversationItem(item))
      .filter((item): item is CodexConversationItem => Boolean(item)),
  };
}

function createUserItem(text: string): CodexConversationItem {
  return {
    id: `user-${Math.random().toString(36).slice(2, 10)}`,
    type: "message",
    role: "user",
    status: "completed",
    content: [{ type: "input_text", text }],
  };
}

function createAssistantItem(itemId: string): CodexConversationItem {
  return {
    id: itemId,
    type: "message",
    role: "assistant",
    status: "in_progress",
    content: [{ type: "output_text", text: "" }],
  };
}

function stringifyEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

class CodexConversationController {
  private listeners = new Set<ControllerListener>();
  private threads = new Map<string, CodexConversationThread>();
  private selectedProjectId = getCodexProjectManager().getDefaultId();
  private currentThreadId: string | null = null;
  private currentTurnId: string | null = null;
  private loadingHistory = false;
  private historyError: string | null = null;
  private resumeRequired = new Set<string>();

  getSnapshot(): CodexConversationSnapshot {
    const projectManager = getCodexProjectManager();
    const selectedProject =
      projectManager.get(this.selectedProjectId) ?? projectManager.getDefault();
    const threads = this.listThreadsForProject(selectedProject.id);
    return {
      selectedProject,
      threads,
      currentThreadId: this.currentThreadId,
      currentTurnId: this.currentTurnId,
      loadingHistory: this.loadingHistory,
      historyError: this.historyError,
    };
  }

  subscribe(listener: ControllerListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setSelectedProject(projectId: string): void {
    const mgr = getCodexProjectManager();
    const project = mgr.get(projectId);
    if (!project) {
      throw new Error(`Codex project ${projectId} not found`);
    }
    this.selectedProjectId = projectId;
    this.currentThreadId = null;
    this.currentTurnId = null;
    mgr.setDefault(projectId);
    this.notify();
  }

  startNewChat(): void {
    this.currentThreadId = null;
    this.currentTurnId = null;
    this.notify();
  }

  async refreshHistory(): Promise<void> {
    const project = this.getSnapshot().selectedProject;
    const proxy = getCodexAppServerProxyClient();
    this.loadingHistory = true;
    this.historyError = null;
    this.notify();
    try {
      const result = await proxy.sendRequest("thread/list", {
        cwd: project.cwd,
      });
      const record = asRecord(result);
      const entries = Array.isArray(record.threads)
        ? (record.threads as unknown[])
        : Array.isArray(record.data)
          ? (record.data as unknown[])
          : [];
      entries
        .map((entry) => parseThreadFromListEntry(entry))
        .filter((thread): thread is CodexConversationThread => Boolean(thread))
        .forEach((thread) => {
          const existing = this.threads.get(thread.id);
          this.threads.set(thread.id, {
            ...thread,
            items: existing?.items ?? [],
          });
        });
    } catch (error) {
      this.historyError = String(error);
      appLogger.error("Failed to refresh codex thread history", {
        attrs: {
          scope: "chatkit.codex_controller",
          error: String(error),
          projectId: project.id,
          cwd: project.cwd,
        },
      });
    } finally {
      this.loadingHistory = false;
      this.notify();
    }
  }

  async getThread(threadId: string): Promise<CodexConversationThread> {
    const proxy = getCodexAppServerProxyClient();
    const result = await proxy.sendRequest("thread/read", { threadId });
    const detail = parseThreadDetail(result);
    if (!detail) {
      throw new Error(`Invalid thread/read response for ${threadId}`);
    }
    const existing = this.threads.get(detail.id);
    this.threads.set(detail.id, {
      ...detail,
      items: detail.items.length > 0 ? detail.items : existing?.items ?? [],
    });
    this.notify();
    return this.threads.get(detail.id)!;
  }

  async selectThread(threadId: string): Promise<CodexConversationThread> {
    const thread = await this.getThread(threadId);
    this.currentThreadId = threadId;
    this.currentTurnId = thread.previousResponseId ?? null;
    this.resumeRequired.add(threadId);
    this.notify();
    return thread;
  }

  async interruptActiveTurn(): Promise<void> {
    if (!this.currentThreadId || !this.currentTurnId) {
      return;
    }
    const proxy = getCodexAppServerProxyClient();
    await proxy.sendRequest("turn/interrupt", {
      threadId: this.currentThreadId,
      turnId: this.currentTurnId,
    });
  }

  async streamUserMessage(
    input: string,
    chatkitState: ChatKitStateValue,
    sink: CodexStreamSink,
  ): Promise<ChatKitStateValue> {
    const proxy = getCodexAppServerProxyClient();
    const project = this.getSnapshot().selectedProject;
    let threadId = chatkitState.threadId ?? this.currentThreadId;

    if (!threadId) {
      const created = asRecord(
        await proxy.sendRequest("thread/start", this.buildProjectDefaults(project)),
      );
      threadId =
        asString(created.threadId) ??
        asString(created.thread_id) ??
        asString(asRecord(created.thread).id);
      if (!threadId) {
        throw new Error("thread/start did not return a thread id");
      }
      this.threads.set(threadId, {
        id: threadId,
        title:
          asString(created.title) ??
          asString(asRecord(created.thread).title) ??
          project.name,
        cwd: project.cwd,
        items: [],
      });
    } else if (this.resumeRequired.has(threadId)) {
      await proxy.sendRequest("thread/resume", {
        threadId,
        ...this.buildProjectDefaults(project),
      });
      this.resumeRequired.delete(threadId);
    }

    this.currentThreadId = threadId;
    this.appendThreadItem(threadId, createUserItem(input));
    this.notify();

    let assistantText = "";
    let finished = false;
    let responseId = "";
    let assistantItemId = "";
    let turnIdForNotifications: string | null = null;
    let resolveCompletion: (() => void) | null = null;
    let rejectCompletion: ((reason?: unknown) => void) | null = null;
    const completionPromise = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const timeoutId = setTimeout(() => {
      rejectCompletion?.(
        new Error(`Timed out waiting for codex turn completion: ${turnId}`),
      );
    }, 30_000);

    const unsubscribe = proxy.subscribeNotifications((notification) => {
      if (finished) {
        return;
      }
      const mapped = this.mapNotificationToAssistantEvent(
        notification,
        threadId!,
        turnIdForNotifications,
      );
      if (!mapped) {
        return;
      }
      if (mapped.kind === "delta") {
        assistantText += mapped.text;
        this.updateAssistantItem(threadId!, assistantItemId, assistantText, "in_progress");
        sink.emit({
          type: "response.output_text.delta",
          response_id: responseId,
          output_index: 0,
          item_id: assistantItemId,
          content_index: 0,
          delta: mapped.text,
        });
        return;
      }
      if (mapped.kind === "done") {
        if (mapped.text) {
          assistantText = mapped.text;
        }
        this.updateAssistantItem(threadId!, assistantItemId, assistantText, "completed");
        sink.emit({
          type: "response.output_text.done",
          response_id: responseId,
          output_index: 0,
          item_id: assistantItemId,
          content_index: 0,
          text: assistantText,
        });
        sink.emit({
          type: "response.content_part.done",
          response_id: responseId,
          output_index: 0,
          item_id: assistantItemId,
          content_index: 0,
          part: { type: "output_text", text: assistantText },
        });
        sink.emit({
          type: "response.output_item.done",
          response_id: responseId,
          output_index: 0,
          item: {
            id: assistantItemId,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: assistantText }],
          },
        });
        return;
      }
      if (mapped.kind === "completed") {
        finished = true;
        resolveCompletion?.();
      }
    });

    try {
      const turnResult = asRecord(
        await proxy.sendRequest("turn/start", {
          threadId,
          input,
        }),
      );
      const turnId =
        asString(turnResult.turnId) ??
        asString(turnResult.turn_id) ??
        asString(turnResult.id) ??
        `turn-${Math.random().toString(36).slice(2, 10)}`;
      turnIdForNotifications = turnId;
      this.currentTurnId = turnId;

      responseId = turnId;
      assistantItemId =
        asString(turnResult.itemId) ??
        asString(turnResult.item_id) ??
        `msg-${Math.random().toString(36).slice(2, 10)}`;

      sink.emit({
        type: "response.created",
        response: { id: responseId },
      });
      sink.emit({
        type: "response.output_item.added",
        response_id: responseId,
        output_index: 0,
        item: {
          id: assistantItemId,
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      });
      sink.emit({
        type: "response.content_part.added",
        response_id: responseId,
        output_index: 0,
        item_id: assistantItemId,
        content_index: 0,
        part: { type: "output_text", text: "" },
      });

      this.appendThreadItem(threadId, createAssistantItem(assistantItemId));
      await completionPromise;
    } finally {
      clearTimeout(timeoutId);
      unsubscribe();
    }

    sink.emit({
      type: "aisre.chatkit.state",
      item: {
        state: {
          threadId,
          previousResponseId: responseId,
        },
      },
    });
    sink.emit({
      type: "response.completed",
      response: { id: responseId },
    });

    const updatedThread = this.threads.get(threadId);
    if (updatedThread) {
      updatedThread.previousResponseId = responseId;
      this.threads.set(threadId, updatedThread);
    }
    this.currentTurnId = responseId;
    this.notify();
    return {
      threadId,
      previousResponseId: responseId,
    };
  }

  async handleListItems(threadId: string): Promise<{ data: CodexConversationItem[]; has_more: false }> {
    const thread = await this.getThread(threadId);
    return {
      data: thread.items,
      has_more: false,
    };
  }

  private buildProjectDefaults(project: CodexProject): JsonRecord {
    return {
      projectId: project.id,
      cwd: project.cwd,
      model: project.model,
      approvalPolicy: project.approvalPolicy,
      sandboxPolicy: project.sandboxPolicy,
      personality: project.personality,
      writableRoots: project.writableRoots,
    };
  }

  private listThreadsForProject(projectId: string): CodexConversationThread[] {
    const project = getCodexProjectManager().get(projectId);
    if (!project) {
      return [];
    }
    return [...this.threads.values()]
      .filter((thread) => !thread.cwd || thread.cwd === project.cwd)
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  private appendThreadItem(threadId: string, item: CodexConversationItem): void {
    const current =
      this.threads.get(threadId) ??
      ({
        id: threadId,
        title: "Untitled thread",
        items: [],
      } satisfies CodexConversationThread);
    current.items = [...current.items, item];
    this.threads.set(threadId, current);
  }

  private updateAssistantItem(
    threadId: string,
    itemId: string,
    text: string,
    status: "in_progress" | "completed",
  ): void {
    const current = this.threads.get(threadId);
    if (!current) {
      return;
    }
    current.items = current.items.map((item) =>
      item.id === itemId
        ? {
            ...item,
            status,
            content: [{ type: "output_text", text }],
          }
        : item,
    );
    this.threads.set(threadId, current);
    this.notify();
  }

  private mapNotificationToAssistantEvent(
    notification: CodexProxyJsonRpcNotification,
    threadId: string,
    turnId: string | null,
  ):
    | { kind: "delta"; text: string }
    | { kind: "done"; text?: string }
    | { kind: "completed" }
    | null {
    const params = asRecord(notification.params);
    const notificationThreadId =
      asString(params.threadId) ?? asString(params.thread_id);
    const notificationTurnId =
      asString(params.turnId) ?? asString(params.turn_id);
    if (
      notificationThreadId &&
      notificationThreadId !== threadId
    ) {
      return null;
    }
    if (turnId && notificationTurnId && notificationTurnId !== turnId) {
      return null;
    }

    switch (notification.method) {
      case "turn.output_text.delta": {
        const delta = asString(params.delta) ?? extractText(params);
        return delta ? { kind: "delta", text: delta } : null;
      }
      case "turn.output_text.done": {
        const text = asString(params.text) ?? extractText(params);
        return { kind: "done", text };
      }
      case "turn.completed":
        return { kind: "completed" };
      default: {
        const type = asString(params.type);
        if (type === "response.output_text.delta") {
          const delta = asString(params.delta) ?? extractText(params);
          return delta ? { kind: "delta", text: delta } : null;
        }
        if (type === "response.output_text.done") {
          const text = asString(params.text) ?? extractText(params);
          return { kind: "done", text };
        }
        if (type === "turn.completed") {
          return { kind: "completed" };
        }
        return null;
      }
    }
  }

  private notify(): void {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        appLogger.error("CodexConversationController listener failed", {
          attrs: {
            scope: "chatkit.codex_controller",
            error: String(error),
          },
        });
      }
    });
  }
}

let singleton: CodexConversationController | null = null;

export function getCodexConversationController(): CodexConversationController {
  if (!singleton) {
    singleton = new CodexConversationController();
  }
  return singleton;
}

export function createCodexConversationControllerForTests(): CodexConversationController {
  return new CodexConversationController();
}

export function resetCodexConversationControllerForTests(): void {
  singleton = null;
}

export function useCodexConversationSnapshot(): CodexConversationSnapshot {
  const controller = useMemo(() => getCodexConversationController(), []);
  const [snapshot, setSnapshot] = useState<CodexConversationSnapshot>(() =>
    controller.getSnapshot(),
  );

  useEffect(() => {
    return controller.subscribe(() => {
      setSnapshot(controller.getSnapshot());
    });
  }, [controller]);

  return snapshot;
}
