import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceDocumentController } from "./workspaceDocumentController";

function createMemoryPersistence(initial: Array<{ uri: string; title: string }> = []) {
  let documents = initial;
  return {
    loadDocuments: vi.fn(() => documents),
    saveDocuments: vi.fn((next: Array<{ uri: string; title: string }>) => {
      documents = next.map((item) => ({ ...item }));
    }),
  };
}

describe("WorkspaceDocumentController", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("shows and deduplicates workspace documents", () => {
    const persistence = createMemoryPersistence();
    const controller = new WorkspaceDocumentController(persistence);

    controller.showDocument("local://file/a", { title: "a.json" });
    controller.showDocument("local://file/a", { title: "renamed.json" });
    controller.showDocument("diff://notebook/1", { title: "Diff" });

    expect(controller.getSnapshot().documents).toEqual([
      { uri: "local://file/a", title: "renamed.json" },
      { uri: "diff://notebook/1", title: "Diff" },
    ]);
  });

  it("closes a document and returns the neighboring fallback", () => {
    const controller = new WorkspaceDocumentController(createMemoryPersistence());
    controller.showDocument("local://file/a", { title: "a.json" });
    controller.showDocument("local://file/b", { title: "b.json" });
    controller.showDocument("diff://notebook/1", { title: "Diff" });

    expect(controller.closeDocument("local://file/b")).toBe("local://file/a");
    expect(controller.getSnapshot().documents.map((item) => item.uri)).toEqual([
      "local://file/a",
      "diff://notebook/1",
    ]);
  });

  it("persists only restorable notebook documents", () => {
    const controller = new WorkspaceDocumentController();

    controller.showDocument("local://file/a", { title: "a.json" });
    controller.showDocument("diff://notebook/1", { title: "Diff" });
    controller.showDocument("status://drive-link", { title: "Drive Link Status" });

    expect(
      JSON.parse(window.sessionStorage.getItem("runme/workspaceDocuments") ?? "[]"),
    ).toEqual([
      { uri: "local://file/a", title: "a.json" },
    ]);
  });

  it("restores only restorable notebook documents", () => {
    const controller = new WorkspaceDocumentController(
      createMemoryPersistence([
        { uri: "diff://notebook/1", title: "Diff" },
        { uri: "local://file/a", title: "a.json" },
        { uri: "status://drive-link", title: "Drive Link Status" },
      ]),
    );

    expect(controller.getSnapshot().documents).toEqual([
      { uri: "local://file/a", title: "a.json" },
    ]);
  });
});
