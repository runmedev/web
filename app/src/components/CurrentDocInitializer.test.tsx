// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CurrentDocInitializer } from "./CurrentDocInitializer";

const mocks = vi.hoisted(() => ({
  getStore: vi.fn(() => null as unknown),
  openNotebook: vi.fn(),
  setCurrentDoc: vi.fn(),
  showDocument: vi.fn(),
}));

vi.mock("../contexts/CurrentDocContext", () => ({
  useCurrentDoc: () => ({
    setCurrentDoc: mocks.setCurrentDoc,
  }),
}));

vi.mock("../contexts/NotebookContext", () => ({
  useNotebookContext: () => ({
    openNotebook: mocks.openNotebook,
  }),
}));

vi.mock("../contexts/WorkspaceDocumentContext", () => ({
  useWorkspaceDocumentContext: () => ({
    showDocument: mocks.showDocument,
  }),
}));

vi.mock("../contexts/NotebookStoreContext", () => ({
  useNotebookStore: () => ({
    store: mocks.getStore(),
  }),
}));

function setDocUrl(uri: string): void {
  const url = new URL("http://localhost/?existing=1#section");
  url.searchParams.set("doc", uri);
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

describe("CurrentDocInitializer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.getStore.mockReset();
    mocks.getStore.mockReturnValue(null);
    mocks.openNotebook.mockReset();
    mocks.setCurrentDoc.mockReset();
    mocks.showDocument.mockReset();
    window.history.replaceState(null, "", "/");
  });

  it("keeps remote doc params until the notebook store is ready", async () => {
    setDocUrl("fs://workspace/demo/file/example.json");

    render(<CurrentDocInitializer />);

    await waitFor(() => {
      expect(mocks.getStore).toHaveBeenCalled();
    });
    expect(mocks.openNotebook).not.toHaveBeenCalled();
    expect(window.location.search).toContain("doc=");
  });

  it("keeps doc params when opening the notebook fails", async () => {
    setDocUrl("fs://workspace/demo/file/example.json");
    mocks.getStore.mockReturnValue({});
    mocks.openNotebook.mockRejectedValue(new Error("Notebook store is not ready"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(<CurrentDocInitializer />);

    await waitFor(() => {
      expect(mocks.openNotebook).toHaveBeenCalledWith(
        "fs://workspace/demo/file/example.json",
      );
    });
    expect(mocks.setCurrentDoc).not.toHaveBeenCalled();
    expect(window.location.search).toContain("doc=");
  });

  it("selects the local URI and clears doc params after a successful open", async () => {
    setDocUrl("fs://workspace/demo/file/example.json");
    mocks.getStore.mockReturnValue({});
    mocks.openNotebook.mockResolvedValue({
      localUri: "local://file/example",
      entry: {
        uri: "local://file/example",
        requestedUri: "fs://workspace/demo/file/example.json",
        name: "example.json",
        state: "loaded",
      },
    });

    render(<CurrentDocInitializer />);

    await waitFor(() => {
      expect(mocks.setCurrentDoc).toHaveBeenCalledWith("local://file/example");
    });
    expect(mocks.showDocument).toHaveBeenCalledWith("local://file/example", {
      title: "example.json",
    });
    expect(window.location.search).toBe("?existing=1");
    expect(window.location.hash).toBe("#section");
  });
});
