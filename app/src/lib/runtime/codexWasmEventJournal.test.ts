import { describe, expect, it } from "vitest";

import { __testing } from "./codexWasmEventJournal";

describe("codexWasmEventJournal", () => {
  it("detects the legacy IndexedDB schema keyed only by seq", () => {
    expect(
      __testing.isLegacyJournalStoreSchema({
        keyPath: "seq",
        autoIncrement: false,
      } as Pick<IDBObjectStore, "keyPath" | "autoIncrement">),
    ).toBe(true);
  });

  it("accepts the append-only auto-increment schema", () => {
    expect(
      __testing.isLegacyJournalStoreSchema({
        keyPath: null,
        autoIncrement: true,
      } as Pick<IDBObjectStore, "keyPath" | "autoIncrement">),
    ).toBe(false);
  });
});
