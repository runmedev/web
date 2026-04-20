import type { CodexWasmAppServerNotification } from "./codexWasmWorkerProtocol";

export type CodexWasmEventAdapterContext = {
  threadId?: string;
  turnId?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function buildNotification(
  method: string,
  params?: unknown,
): CodexWasmAppServerNotification {
  return {
    jsonrpc: "2.0",
    method,
    params,
  };
}

export function adaptCodexWasmEvent(
  event: unknown,
  context: CodexWasmEventAdapterContext,
): CodexWasmAppServerNotification[] {
  const record = asRecord(event);
  const method = asString(record.method);
  if (method) {
    return [buildNotification(method, record.params)];
  }

  const eventType = asString(record.type);
  if (eventType !== "raw_core_event" && eventType !== "coreEvent") {
    return [];
  }

  const rawEvent = asRecord(record.event);
  const msg = asRecord(rawEvent.msg);
  const msgType = asString(msg.type);
  if (!msgType) {
    return [];
  }

  const turnId =
    asString(msg.turn_id) ??
    asString(msg.turnId) ??
    asString(rawEvent.id) ??
    context.turnId;
  const threadId = context.threadId;
  const itemId = turnId ? `${turnId}-item` : "codex-wasm-item";

  switch (msgType) {
    case "task_started":
    case "turn_started":
      if (!turnId) {
        return [];
      }
      return [
        buildNotification("turn/started", {
          threadId,
          turn: { id: turnId },
        }),
      ];
    case "agent_message_delta":
    case "agent_message_content_delta": {
      const delta = asString(msg.delta) ?? asString(msg.text);
      if (!delta) {
        return [];
      }
      return [
        buildNotification("item/agentMessage/delta", {
          threadId,
          turnId,
          itemId,
          delta,
        }),
      ];
    }
    case "agent_message": {
      const text = asString(msg.message) ?? asString(msg.text);
      if (!text) {
        return [];
      }
      return [
        buildNotification("item/completed", {
          threadId,
          turnId,
          item: {
            type: "agentMessage",
            id: itemId,
            text,
          },
        }),
      ];
    }
    case "task_complete":
    case "turn_complete": {
      const notifications: CodexWasmAppServerNotification[] = [];
      const lastAgentMessage =
        asString(msg.last_agent_message) ?? asString(msg.lastAgentMessage);
      if (lastAgentMessage) {
        notifications.push(
          buildNotification("item/completed", {
            threadId,
            turnId,
            item: {
              type: "agentMessage",
              id: itemId,
              text: lastAgentMessage,
            },
          }),
        );
      }
      if (turnId) {
        notifications.push(
          buildNotification("turn/completed", {
            threadId,
            turn: { id: turnId },
          }),
        );
      }
      return notifications;
    }
    default:
      return [];
  }
}
