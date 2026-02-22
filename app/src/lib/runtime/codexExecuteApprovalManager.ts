export type PendingCodexExecuteRequest = {
  bridgeCallId: string;
  refIds: string[];
  createdAtMs: number;
};

type PendingEntry = PendingCodexExecuteRequest & {
  resolve: () => void;
  reject: (error: Error) => void;
};

class CodexExecuteApprovalManager {
  private pending = new Map<string, PendingEntry>();
  private listeners = new Set<() => void>();

  requestApproval(bridgeCallId: string, refIds: string[]): Promise<void> {
    if (!bridgeCallId) {
      return Promise.reject(new Error("bridgeCallId is required"));
    }
    if (this.pending.has(bridgeCallId)) {
      return Promise.reject(new Error(`Pending execute request already exists: ${bridgeCallId}`));
    }
    const normalizedRefIds = refIds.filter((id) => typeof id === "string" && id.trim() !== "");
    return new Promise<void>((resolve, reject) => {
      this.pending.set(bridgeCallId, {
        bridgeCallId,
        refIds: normalizedRefIds,
        createdAtMs: Date.now(),
        resolve: () => {
          this.pending.delete(bridgeCallId);
          this.notify();
          resolve();
        },
        reject: (error: Error) => {
          this.pending.delete(bridgeCallId);
          this.notify();
          reject(error);
        },
      });
      this.notify();
    });
  }

  listPending(): PendingCodexExecuteRequest[] {
    return [...this.pending.values()]
      .map(({ bridgeCallId, refIds, createdAtMs }) => ({ bridgeCallId, refIds: [...refIds], createdAtMs }))
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  approve(refIds?: string[]): string {
    const target = this.findPending(refIds);
    if (!target) {
      return "No pending codex ExecuteCells requests.";
    }
    target.resolve();
    return `Approved codex ExecuteCells request ${target.bridgeCallId} (${target.refIds.join(", ")})`;
  }

  reject(refIds?: string[], reason = "User rejected ExecuteCells request"): string {
    const target = this.findPending(refIds);
    if (!target) {
      return "No pending codex ExecuteCells requests.";
    }
    target.reject(new Error(reason));
    return `Rejected codex ExecuteCells request ${target.bridgeCallId}`;
  }

  failAll(reason: string): void {
    const entries = [...this.pending.values()];
    entries.forEach((entry) => {
      entry.reject(new Error(reason));
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  resetForTests(): void {
    this.pending.clear();
    this.notify();
  }

  private findPending(refIds?: string[]): PendingEntry | undefined {
    const entries = [...this.pending.values()].sort((a, b) => a.createdAtMs - b.createdAtMs);
    if (!refIds || refIds.length === 0) {
      return entries[0];
    }
    const normalized = refIds.map((id) => id.trim()).filter(Boolean);
    return entries.find((entry) => {
      if (entry.refIds.length !== normalized.length) {
        return false;
      }
      return entry.refIds.every((id, index) => id === normalized[index]);
    });
  }

  private notify(): void {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        console.error("CodexExecuteApprovalManager listener failed", error);
      }
    });
  }
}

let singleton: CodexExecuteApprovalManager | null = null;

export function getCodexExecuteApprovalManager(): CodexExecuteApprovalManager {
  if (!singleton) {
    singleton = new CodexExecuteApprovalManager();
  }
  return singleton;
}

export function resetCodexExecuteApprovalManagerForTests(): void {
  singleton = null;
}

