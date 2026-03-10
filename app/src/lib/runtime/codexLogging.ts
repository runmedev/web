import { appLogger } from "../logging/runtime";

type JsonRecord = Record<string, unknown>;

type CodexLogDirection = "outbound" | "inbound" | "derived";
type CodexLogTransport = "codex_proxy" | "codex_bridge" | "chatkit_fetch";

export type CodexLogIdentifiers = {
  threadId?: string;
  turnId?: string;
  itemId?: string;
};

export type CodexLogEvent = CodexLogIdentifiers & {
  scope: string;
  direction: CodexLogDirection;
  transport: CodexLogTransport;
  jsonrpcMethod?: string;
  requestId?: string | number;
  bridgeCallId?: string;
  requestType?: string;
  url?: string | null;
  payload?: unknown;
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

function redactString(value: string): string {
  const trimmed = value.trim();
  if (/^Bearer\s+/i.test(trimmed)) {
    return "Bearer [REDACTED]";
  }

  try {
    const url = new URL(value);
    if (url.searchParams.has("session_token")) {
      url.searchParams.set("session_token", "[REDACTED]");
      return url.toString();
    }
  } catch {
    // Ignore invalid URLs and fall back to regex-based redaction.
  }

  return value.replace(/session_token=([^&\s]+)/gi, "session_token=[REDACTED]");
}

export function sanitizeCodexLogPayload(value: unknown): unknown {
  if (value == null) {
    return value;
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeCodexLogPayload(item));
  }
  if (typeof value !== "object") {
    return value;
  }

  const record = value as JsonRecord;
  const sanitized: JsonRecord = {};
  Object.entries(record).forEach(([key, nestedValue]) => {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === "authorization" ||
      normalizedKey === "session_token" ||
      normalizedKey === "sessiontoken" ||
      normalizedKey === "bearertoken" ||
      normalizedKey === "cookie" ||
      normalizedKey === "cookies" ||
      normalizedKey === "set-cookie"
    ) {
      sanitized[key] = "[REDACTED]";
      return;
    }
    sanitized[key] = sanitizeCodexLogPayload(nestedValue);
  });
  return sanitized;
}

export function extractCodexLogIdentifiers(value: unknown): CodexLogIdentifiers {
  const record = asRecord(value);
  const threadRecord = asRecord(record.thread);
  const turnRecord = asRecord(record.turn);
  const itemRecord = asRecord(record.item);
  const msgRecord = asRecord(record.msg);

  const threadId =
    asString(record.threadId) ??
    asString(record.thread_id) ??
    asString(threadRecord.id) ??
    asString(msgRecord.threadId) ??
    asString(msgRecord.thread_id);
  const turnId =
    asString(record.turnId) ??
    asString(record.turn_id) ??
    asString(turnRecord.id) ??
    asString(record.responseId) ??
    asString(record.response_id) ??
    asString(msgRecord.turnId) ??
    asString(msgRecord.turn_id);
  const itemId =
    asString(record.itemId) ??
    asString(record.item_id) ??
    asString(itemRecord.id) ??
    asString(msgRecord.itemId) ??
    asString(msgRecord.item_id);

  return { threadId, turnId, itemId };
}

export function logCodexEvent(message: string, event: CodexLogEvent): void {
  const payload = sanitizeCodexLogPayload(event.payload);
  const identifiers = extractCodexLogIdentifiers(payload);
  appLogger.info(message, {
    attrs: {
      ...event,
      ...identifiers,
      payload,
    },
  });
}
