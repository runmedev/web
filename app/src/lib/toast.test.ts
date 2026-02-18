import { describe, expect, it, vi } from "vitest";

const { appLoggerError } = vi.hoisted(() => ({
  appLoggerError: vi.fn(),
}));
vi.mock("./logging/runtime", () => ({
  appLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: appLoggerError,
  },
}));

import { showToast, subscribeToast } from "./toast";

describe("toast", () => {
  it("emits to listeners", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToast(listener);

    showToast({ message: "ok", tone: "success" });
    expect(listener).toHaveBeenCalledWith({ message: "ok", tone: "success" });

    unsubscribe();
  });

  it("logs error toasts", () => {
    appLoggerError.mockClear();

    showToast({ message: "boom", tone: "error" });
    expect(appLoggerError).toHaveBeenCalledWith(
      "User-visible error toast",
      expect.objectContaining({
        attrs: expect.objectContaining({
          message: "boom",
        }),
      }),
    );
  });
});
