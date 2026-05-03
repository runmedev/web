import { describe, expect, it } from "vitest";

import { coerceRestoredCells, createDraftCell, type PersistedConsoleCellRow } from "./model";

describe("coerceRestoredCells", () => {
  it("converts running cells into recovered errors and appends a new draft", () => {
    const restored: PersistedConsoleCellRow[] = [
      {
        ...createDraftCell(1, "app.runners.get()"),
        sessionId: "session-1",
        status: "running",
        updatedAt: "2026-05-02T12:00:00.000Z",
      },
    ];

    const result = coerceRestoredCells(restored, "2026-05-02T12:05:00.000Z");

    expect(result.mutated).toBe(true);
    expect(result.cells).toHaveLength(2);
    expect(result.cells[0].status).toBe("error");
    expect(result.cells[0].exitCode).toBe(1);
    expect(result.cells[1].status).toBe("draft");
  });
});
