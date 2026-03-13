import { describe, expect, it, vi } from "vitest";

import { ensurePersistentStorage } from "./persistentStorage";

describe("ensurePersistentStorage", () => {
  it("returns unsupported when no storage manager is available", async () => {
    await expect(ensurePersistentStorage(null)).resolves.toBe("unsupported");
  });

  it("returns unsupported when persist API is unavailable", async () => {
    await expect(ensurePersistentStorage({})).resolves.toBe("unsupported");
  });

  it("returns already-persistent when storage is already persistent", async () => {
    const persisted = vi.fn().mockResolvedValue(true);
    const persist = vi.fn();

    await expect(
      ensurePersistentStorage({
        persisted,
        persist,
      }),
    ).resolves.toBe("already-persistent");
    expect(persist).not.toHaveBeenCalled();
  });

  it("requests persistence when storage is not yet persistent", async () => {
    const persisted = vi.fn().mockResolvedValue(false);
    const persist = vi.fn().mockResolvedValue(true);

    await expect(
      ensurePersistentStorage({
        persisted,
        persist,
      }),
    ).resolves.toBe("persisted");
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("returns not-granted when browser declines persistence", async () => {
    const persist = vi.fn().mockResolvedValue(false);

    await expect(ensurePersistentStorage({ persist })).resolves.toBe(
      "not-granted",
    );
  });

  it("still tries persist when persisted check throws", async () => {
    const persisted = vi.fn().mockRejectedValue(new Error("unavailable"));
    const persist = vi.fn().mockResolvedValue(true);

    await expect(
      ensurePersistentStorage({
        persisted,
        persist,
      }),
    ).resolves.toBe("persisted");
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("returns error when persist throws", async () => {
    const persist = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(ensurePersistentStorage({ persist })).resolves.toBe("error");
  });
});
