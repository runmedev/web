import {
  queryCodexWasmJournalEntries,
} from "./codexWasmEventJournal";
import type { CodexWasmJournalEntry } from "./codexWasmWorkerProtocol";

export type CodexTurnSummary = {
  turnId: string;
  threadId: string | null;
  sessionId: string;
  startedAt: string;
  completedAt: string | null;
  lastEventAt: string;
  eventCount: number;
  methods: string[];
};

function compareJournalEntries(
  left: CodexWasmJournalEntry,
  right: CodexWasmJournalEntry,
): number {
  if (left.sessionId !== right.sessionId) {
    return left.sessionId.localeCompare(right.sessionId);
  }
  return left.seq - right.seq;
}

function isTurnCompletedEntry(entry: CodexWasmJournalEntry): boolean {
  return (
    entry.method === "turn/completed" ||
    entry.method === "turn.completed"
  );
}

export function summarizeCodexTurns(
  entries: CodexWasmJournalEntry[],
): CodexTurnSummary[] {
  const sorted = [...entries].sort(compareJournalEntries);
  const turns = new Map<string, CodexTurnSummary>();

  for (const entry of sorted) {
    if (!entry.turnId) {
      continue;
    }

    const key = `${entry.sessionId}:${entry.turnId}`;
    const existing = turns.get(key);
    const summary =
      existing ??
      {
        turnId: entry.turnId,
        threadId: entry.threadId ?? null,
        sessionId: entry.sessionId,
        startedAt: entry.ts,
        completedAt: null,
        lastEventAt: entry.ts,
        eventCount: 0,
        methods: [],
      };

    summary.threadId = summary.threadId ?? entry.threadId ?? null;
    summary.startedAt = summary.startedAt.localeCompare(entry.ts) <= 0
      ? summary.startedAt
      : entry.ts;
    summary.lastEventAt = summary.lastEventAt.localeCompare(entry.ts) >= 0
      ? summary.lastEventAt
      : entry.ts;
    summary.eventCount += 1;

    if (entry.method && !summary.methods.includes(entry.method)) {
      summary.methods.push(entry.method);
    }
    if (isTurnCompletedEntry(entry)) {
      summary.completedAt = entry.ts;
    }

    turns.set(key, summary);
  }

  return [...turns.values()].sort((left, right) =>
    right.lastEventAt.localeCompare(left.lastEventAt),
  );
}

export async function listCodexTurns(): Promise<CodexTurnSummary[]> {
  const entries = await queryCodexWasmJournalEntries();
  return summarizeCodexTurns(entries);
}

export async function getCodexTurnEvents(
  turnId: string,
  options?: {
    sessionId?: string;
  },
): Promise<CodexWasmJournalEntry[]> {
  const normalizedTurnId = turnId.trim();
  if (!normalizedTurnId) {
    return [];
  }
  const entries = await queryCodexWasmJournalEntries({
    turnId: normalizedTurnId,
  });
  return entries
    .filter((entry) =>
      entry.turnId === normalizedTurnId &&
      (!options?.sessionId || entry.sessionId === options.sessionId)
    )
    .sort(compareJournalEntries);
}
