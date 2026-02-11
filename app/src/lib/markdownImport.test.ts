import { describe, expect, it, vi, afterEach } from "vitest";
import { create } from "@bufbuild/protobuf";

import { parser_pb } from "../runme/client";
import { aisreClientManager } from "./aisreClientManager";
import {
  deserializeMarkdownToNotebook,
  getPickedMarkdownSelection,
  getImportedFileBytes,
  getImportedFileName,
  pickMarkdownSource,
  registerImportedMarkdownForUri,
  toImportedNotebookName,
} from "./markdownImport";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("toImportedNotebookName", () => {
  it("converts markdown extensions to .json", () => {
    expect(toImportedNotebookName("notes.md")).toBe("notes.json");
    expect(toImportedNotebookName("team.runme.md")).toBe("team.json");
    expect(toImportedNotebookName("subdir/dev-notes.markdown")).toBe("dev-notes.json");
  });

  it("handles blank values", () => {
    expect(toImportedNotebookName("")).toBe("imported-notebook.json");
    expect(toImportedNotebookName("   ")).toBe("imported-notebook.json");
  });
});

describe("deserializeMarkdownToNotebook", () => {
  it("falls back to a single markup cell when parser service fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const deserializeNotebook = vi
      .fn()
      .mockRejectedValue(new Error("parser unavailable"));
    vi.spyOn(aisreClientManager, "get").mockReturnValue({
      deserializeNotebook,
    } as any);

    const notebook = await deserializeMarkdownToNotebook({
      name: "fallback.md",
      text: "# Title\ncontent",
      bytes: new TextEncoder().encode("# Title\ncontent"),
    });

    expect(notebook.cells).toHaveLength(1);
    expect(notebook.cells[0]?.kind).toBe(parser_pb.CellKind.MARKUP);
    expect(notebook.cells[0]?.value).toBe("# Title\ncontent");
  });

  it("returns parser output when deserialization succeeds", async () => {
    const expected = create(parser_pb.NotebookSchema, {
      cells: [],
      metadata: {},
    });

    const deserializeNotebook = vi.fn().mockResolvedValue(expected);
    vi.spyOn(aisreClientManager, "get").mockReturnValue({
      deserializeNotebook,
    } as any);

    const notebook = await deserializeMarkdownToNotebook({
      name: "ok.md",
      text: "hello",
      bytes: new TextEncoder().encode("hello"),
    });

    expect(notebook).toBe(expected);
  });
});

describe("registerImportedMarkdownForUri", () => {
  it("stores and returns bytes/name for a local notebook URI", async () => {
    const uri = "local://file/test-import";
    registerImportedMarkdownForUri(uri, {
      name: "hello.md",
      text: "# hello",
      bytes: new TextEncoder().encode("# hello"),
    });

    const bytes = getImportedFileBytes(uri);
    expect(new TextDecoder().decode(bytes)).toBe("# hello");
    expect(getImportedFileName(uri)).toBe("hello.md");
  });
});

describe("pickMarkdownSource", () => {
  it("returns a source URI and resolves picked selection", async () => {
    const file = {
      name: "hello.md",
      text: vi.fn().mockResolvedValue("# hello"),
    } as any;
    const getFile = vi.fn().mockResolvedValue(file);
    (window as any).showOpenFilePicker = vi.fn().mockResolvedValue([
      {
        kind: "file",
        name: "hello.md",
        getFile,
      },
    ]);

    const picked = await pickMarkdownSource();
    expect(picked).toBeTruthy();
    expect(picked?.sourceUri.startsWith("local://picked-markdown/")).toBe(true);
    const selection = getPickedMarkdownSelection(picked!.sourceUri);
    expect(selection.name).toBe("hello.md");
    expect(selection.text).toBe("# hello");
  });

  it("throws a helpful error for absolute filesystem paths", () => {
    expect(() =>
      getPickedMarkdownSelection("/Users/jlewi/code/openai/test.md"),
    ).toThrow(/Direct absolute filesystem paths are not accessible/);
  });
});
