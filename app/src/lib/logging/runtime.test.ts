import { describe, expect, it, vi } from "vitest";

import { createLoggingRuntime } from "./runtime";

describe("logging runtime", () => {
  it("stores newest-first events and returns snapshots", () => {
    const runtime = createLoggingRuntime();

    runtime.log("info", "first");
    runtime.log("error", "second", { attrs: { code: "E2" } });

    const events = runtime.list();
    expect(events).toHaveLength(2);
    expect(events[0].message).toBe("second");
    expect(events[1].message).toBe("first");
    expect(events[0].attrs).toEqual({ code: "E2" });

    events[0].message = "mutated";
    expect(runtime.list()[0].message).toBe("second");
  });

  it("supports level filters and limits", () => {
    const runtime = createLoggingRuntime();

    runtime.log("debug", "d");
    runtime.log("info", "i");
    runtime.log("warn", "w");
    runtime.log("error", "e");

    expect(runtime.list({ minLevel: "warn" }).map((event) => event.level)).toEqual([
      "error",
      "warn",
    ]);
    expect(runtime.list({ level: "info" }).map((event) => event.message)).toEqual(["i"]);
    expect(runtime.list({ limit: 1 })).toHaveLength(1);
  });

  it("keeps only a bounded in-memory history", () => {
    const runtime = createLoggingRuntime();

    for (let index = 0; index < 520; index += 1) {
      runtime.log("info", `m-${index}`);
    }

    const events = runtime.list();
    expect(events).toHaveLength(500);
    expect(events[0].message).toBe("m-519");
    expect(events[events.length - 1].message).toBe("m-20");
  });

  it("notifies subscribers and supports unsubscribe", () => {
    const runtime = createLoggingRuntime();
    const listener = vi.fn();

    const unsubscribe = runtime.subscribe(listener);
    runtime.log("info", "before-unsubscribe");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    runtime.log("info", "after-unsubscribe");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("falls back to a generated id when randomUUID throws", () => {
    const runtime = createLoggingRuntime();
    const randomUUIDSpy = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockImplementation(() => {
        throw new Error("randomUUID unavailable");
      });

    try {
      const event = runtime.log("info", "fallback-id");
      expect(event.id).toMatch(/^log-/);
    } finally {
      randomUUIDSpy.mockRestore();
    }
  });
});
