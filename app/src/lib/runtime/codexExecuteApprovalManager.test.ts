import { describe, expect, it, beforeEach } from "vitest";

import {
  getCodexExecuteApprovalManager,
  resetCodexExecuteApprovalManagerForTests,
} from "./codexExecuteApprovalManager";

describe("CodexExecuteApprovalManager", () => {
  beforeEach(() => {
    resetCodexExecuteApprovalManagerForTests();
  });

  it("queues a pending request and approves by refIds", async () => {
    const mgr = getCodexExecuteApprovalManager();
    const approved = mgr.requestApproval("bridge_1", ["cell_a", "cell_b"]);

    expect(mgr.listPending()).toHaveLength(1);
    expect(mgr.approve(["cell_a", "cell_b"])).toContain("Approved codex ExecuteCells request");

    await expect(approved).resolves.toBeUndefined();
    expect(mgr.listPending()).toHaveLength(0);
  });

  it("rejects and clears pending request", async () => {
    const mgr = getCodexExecuteApprovalManager();
    const pending = mgr.requestApproval("bridge_2", ["cell_x"]);

    expect(mgr.reject(["cell_x"])).toContain("Rejected codex ExecuteCells request");
    await expect(pending).rejects.toThrow("User rejected ExecuteCells request");
    expect(mgr.listPending()).toHaveLength(0);
  });

  it("reports no pending requests when approving empty queue", () => {
    const mgr = getCodexExecuteApprovalManager();
    expect(mgr.approve(["missing"])).toBe("No pending codex ExecuteCells requests.");
  });

  it("fails all pending requests on disconnect", async () => {
    const mgr = getCodexExecuteApprovalManager();
    const first = mgr.requestApproval("bridge_3", ["cell_a"]);
    const second = mgr.requestApproval("bridge_4", ["cell_b"]);

    mgr.failAll("Codex bridge disconnected");

    await expect(first).rejects.toThrow("Codex bridge disconnected");
    await expect(second).rejects.toThrow("Codex bridge disconnected");
    expect(mgr.listPending()).toHaveLength(0);
  });
});
