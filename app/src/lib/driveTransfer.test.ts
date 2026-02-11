import { afterEach, describe, expect, it, vi } from "vitest";

import { appState } from "./runtime/AppState";
import { createDriveFile, updateDriveFileBytes } from "./driveTransfer";

afterEach(() => {
  vi.restoreAllMocks();
  appState.setDriveNotebookStore(null);
});

describe("driveTransfer", () => {
  it("creates a drive file and returns parsed id", async () => {
    const create = vi.fn().mockResolvedValue({
      uri: "https://drive.google.com/file/d/abc123/view",
    });
    appState.setDriveNotebookStore({ create } as any);

    const id = await createDriveFile("folder123", "notes.md");
    expect(id).toBe("abc123");
    expect(create).toHaveBeenCalledWith(
      "https://drive.google.com/drive/folders/folder123",
      "notes.md",
    );
  });

  it("updates drive file bytes using saveContent", async () => {
    const saveContent = vi.fn().mockResolvedValue(undefined);
    appState.setDriveNotebookStore({ saveContent } as any);

    const id = await updateDriveFileBytes(
      "abc123",
      new TextEncoder().encode("hello"),
    );

    expect(id).toBe("abc123");
    expect(saveContent).toHaveBeenCalledWith(
      "https://drive.google.com/file/d/abc123/view",
      "hello",
      "text/markdown",
    );
  });
});

