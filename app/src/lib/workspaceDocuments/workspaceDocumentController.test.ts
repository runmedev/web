import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceDocumentController } from "./workspaceDocumentController";
import {
  deriveWorkspaceDocumentTitle,
  getOperationLogSuggestionDocumentUri,
  getRunnerKernelsDocumentUri,
  parseOperationLogSuggestionDocumentUri,
  parseRunnerKernelsDocumentUri,
  type WorkspaceDocument,
} from "./workspaceDocumentTypes";
import { EXCALIDRAW_MIME_TYPE } from "../../storage/excalidraw";

function createMemoryPersistence(initial: WorkspaceDocument[] = []) {
  let documents = initial;
  return {
    loadDocuments: vi.fn(() => documents),
    saveDocuments: vi.fn((next: WorkspaceDocument[]) => {
      documents = next.map((item) => ({ ...item }));
    }),
  };
}

describe("WorkspaceDocumentController", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("restores adjacent editor/review tabs from session persistence", () => {
    const uri = "local://file/review";
    const reviewUri = getOperationLogSuggestionDocumentUri(uri);
    const controller = new WorkspaceDocumentController();
    controller.showDocument(uri, {title:"review.runme"});
    controller.showDocument(reviewUri, {title:"Suggestions · review.runme",afterUri:uri});
    const restored = new WorkspaceDocumentController();
    expect(restored.getSnapshot().documents.map(d=>d.uri)).toEqual([uri,reviewUri]);
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

  it("keeps a suggestion document immediately after its notebook", () => {
    const controller = new WorkspaceDocumentController(createMemoryPersistence());
    const notebookUri = "local://file/a";
    const suggestionUri = getOperationLogSuggestionDocumentUri(notebookUri);

    controller.showDocument(notebookUri, { title: "a.runme" });
    controller.showDocument("local://file/b", { title: "b.runme" });
    controller.showDocument(suggestionUri, {
      title: "Suggestions · a.runme",
      afterUri: notebookUri,
    });

    expect(controller.getSnapshot().documents.map((item) => item.uri)).toEqual([
      notebookUri,
      suggestionUri,
      "local://file/b",
    ]);
  });

  it("moves an existing suggestion document next to its notebook", () => {
    const controller = new WorkspaceDocumentController(createMemoryPersistence());
    const notebookUri = "local://file/a";
    const suggestionUri = getOperationLogSuggestionDocumentUri(notebookUri);

    controller.showDocument(notebookUri, { title: "a.runme" });
    controller.showDocument("local://file/b", { title: "b.runme" });
    controller.showDocument(suggestionUri, { title: "Notebook suggestions" });
    controller.showDocument(suggestionUri, {
      title: "Suggestions · a.runme",
      afterUri: notebookUri,
    });

    expect(controller.getSnapshot().documents.map((item) => item.uri)).toEqual([
      notebookUri,
      suggestionUri,
      "local://file/b",
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

  it("persists only restorable workspace documents", () => {
    const controller = new WorkspaceDocumentController();

    controller.showDocument("local://file/a", { title: "a.json" });
    controller.showDocument("local://file/diagram123", {
      title: "diagram.excalidraw",
      requestedUri: "https://drive.google.com/file/d/diagram123/view",
      mimeType: EXCALIDRAW_MIME_TYPE,
    });
    controller.showDocument("diff://notebook/1", { title: "Diff" });
    controller.showDocument("status://drive-link", { title: "Drive Link Status" });
    controller.showDocument(
      "https://github.com/runmedev/web/blob/abc123/docs/00-getting-started.md",
      { title: "Getting Started", mimeType: "text/markdown", readOnly: true },
    );

    expect(
      JSON.parse(window.sessionStorage.getItem("runme/workspaceDocuments") ?? "[]"),
    ).toEqual([
      { uri: "local://file/a", title: "a.json" },
      {
        uri: "local://file/diagram123",
        title: "diagram.excalidraw",
        requestedUri: "https://drive.google.com/file/d/diagram123/view",
        mimeType: EXCALIDRAW_MIME_TYPE,
      },
      {
        uri: "https://github.com/runmedev/web/blob/abc123/docs/00-getting-started.md",
        title: "Getting Started",
        mimeType: "text/markdown",
        readOnly: true,
      },
    ]);
  });

  it("restores only restorable workspace documents", () => {
    const controller = new WorkspaceDocumentController(
      createMemoryPersistence([
        { uri: "diff://notebook/1", title: "Diff" },
        { uri: "local://file/a", title: "a.json" },
        {
          uri: "local://file/diagram123",
          title: "diagram.excalidraw",
          requestedUri: "https://drive.google.com/file/d/diagram123/view",
          mimeType: EXCALIDRAW_MIME_TYPE,
        },
        { uri: "excalidraw://drive/old", title: "old.excalidraw" },
        { uri: "status://drive-link", title: "Drive Link Status" },
      ]),
    );

    expect(controller.getSnapshot().documents).toEqual([
      { uri: "local://file/a", title: "a.json" },
      {
        uri: "local://file/diagram123",
        title: "diagram.excalidraw",
        requestedUri: "https://drive.google.com/file/d/diagram123/view",
        mimeType: EXCALIDRAW_MIME_TYPE,
      },
    ]);
  });

  it("derives titles for App Console and Logs documents", () => {
    expect(deriveWorkspaceDocumentTitle("app://console")).toBe("App Console");
    expect(deriveWorkspaceDocumentTitle("app://logs")).toBe("Logs");
  });

  it("creates and parses runner-scoped kernel status documents", () => {
    const uri = getRunnerKernelsDocumentUri("local runner");

    expect(uri).toBe("status://runners/local%20runner/kernels");
    expect(parseRunnerKernelsDocumentUri(uri)).toEqual({
      runnerName: "local runner",
    });
    expect(deriveWorkspaceDocumentTitle(uri)).toBe("Kernels · local runner");
  });

  it("creates and parses a distinct suggestion tab for a notebook", () => {
    const notebookUri = "local://file/notebook-1";
    const suggestionUri = getOperationLogSuggestionDocumentUri(notebookUri);

    expect(suggestionUri).toBe(
      "suggestion://notebook/local%3A%2F%2Ffile%2Fnotebook-1"
    );
    expect(parseOperationLogSuggestionDocumentUri(suggestionUri)).toBe(
      notebookUri
    );
    expect(deriveWorkspaceDocumentTitle(suggestionUri)).toBe(
      "Notebook suggestions"
    );
    expect(
      parseOperationLogSuggestionDocumentUri("suggestion://notebook/bad")
    ).toBeNull();
  });
});
