import { create } from "@bufbuild/protobuf";

import { parser_pb } from "../runme/client";
import { aisreClientManager } from "./aisreClientManager";

declare global {
  interface Window {
    showOpenFilePicker?: (
      options?: OpenFilePickerOptions,
    ) => Promise<FileSystemFileHandle[]>;
  }

  interface OpenFilePickerOptions {
    multiple?: boolean;
    types?: FilePickerAcceptType[];
    excludeAcceptAllOption?: boolean;
  }

  interface FilePickerAcceptType {
    description?: string;
    accept: Record<string, string[]>;
  }

  interface FileSystemFileHandle {
    kind: "file";
    name: string;
    getFile: () => Promise<File>;
  }
}

export type LocalMarkdownSelection = {
  name: string;
  text: string;
  bytes: Uint8Array;
};

const importedFileBytes = new Map<string, Uint8Array>();
const importedFileNames = new Map<string, string>();
const pickedFileSelections = new Map<string, LocalMarkdownSelection>();

function createSingleMarkupCellNotebook(markdownText: string): parser_pb.Notebook {
  return create(parser_pb.NotebookSchema, {
    cells: [
      create(parser_pb.CellSchema, {
        kind: parser_pb.CellKind.MARKUP,
        role: parser_pb.CellRole.USER,
        languageId: "markdown",
        refId: `markup_${crypto.randomUUID().replace(/-/g, "")}`,
        value: markdownText,
        metadata: {},
      }),
    ],
    metadata: {},
  });
}

async function readMarkdownFile(file: File): Promise<LocalMarkdownSelection> {
  let bytes: Uint8Array;
  if (typeof (file as any).text === "function") {
    const text = await (file as any).text();
    bytes = new TextEncoder().encode(text);
  } else if (typeof (file as any).arrayBuffer === "function") {
    const buffer = await (file as any).arrayBuffer();
    bytes = new Uint8Array(buffer);
  } else {
    throw new Error("Selected file does not support text or arrayBuffer reads");
  }
  const text = new TextDecoder().decode(bytes);
  return {
    name: file.name || "imported-notebook.md",
    text,
    bytes,
  };
}

async function pickWithFileInput(): Promise<LocalMarkdownSelection | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,text/markdown,text/plain";
    input.style.display = "none";

    input.onchange = async () => {
      const file = input.files?.[0] ?? null;
      input.remove();
      if (!file) {
        resolve(null);
        return;
      }
      resolve(await readMarkdownFile(file));
    };

    input.oncancel = () => {
      input.remove();
      resolve(null);
    };

    document.body.appendChild(input);
    input.click();
  });
}

export async function pickMarkdownFromLocalFilesystem(): Promise<LocalMarkdownSelection | null> {
  if (
    typeof window !== "undefined" &&
    typeof window.showOpenFilePicker === "function"
  ) {
    try {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        excludeAcceptAllOption: false,
        types: [
          {
            description: "Markdown files",
            accept: {
              "text/markdown": [".md", ".markdown"],
              "text/plain": [".md", ".markdown"],
            },
          },
        ],
      });
      if (!handle) {
        return null;
      }
      const file = await handle.getFile();
      return readMarkdownFile(file);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return null;
      }
      throw error;
    }
  }

  return pickWithFileInput();
}

export function registerImportedMarkdownForUri(
  localUri: string,
  selection: LocalMarkdownSelection,
): void {
  importedFileBytes.set(localUri, selection.bytes);
  importedFileNames.set(localUri, selection.name);
}

function buildPickedMarkdownUri(fileName: string): string {
  const encodedName = encodeURIComponent(fileName || "imported.md");
  const id = crypto.randomUUID();
  return `local://picked-markdown/${id}/${encodedName}`;
}

export async function pickMarkdownSource(): Promise<{
  sourceUri: string;
  name: string;
  size: number;
} | null> {
  const selection = await pickMarkdownFromLocalFilesystem();
  if (!selection) {
    return null;
  }
  const sourceUri = buildPickedMarkdownUri(selection.name);
  pickedFileSelections.set(sourceUri, selection);
  return {
    sourceUri,
    name: selection.name,
    size: selection.bytes.byteLength,
  };
}

export function getPickedMarkdownSelection(sourceUri: string): LocalMarkdownSelection {
  const selection = pickedFileSelections.get(sourceUri);
  if (selection) {
    return selection;
  }

  if (sourceUri.startsWith("/")) {
    throw new Error(
      "Direct absolute filesystem paths are not accessible from the browser. Use files.pickMarkdown() first and pass its sourceUri to files.importMarkdown(sourceUri).",
    );
  }

  throw new Error(
    `No picked markdown source found for URI: ${sourceUri}. Use files.pickMarkdown() first.`,
  );
}

export function getImportedFileBytes(localUri: string): Uint8Array {
  const bytes = importedFileBytes.get(localUri);
  if (!bytes) {
    throw new Error(`No imported markdown bytes found for URI: ${localUri}`);
  }
  return bytes;
}

export function getImportedFileName(localUri: string): string {
  const name = importedFileNames.get(localUri);
  if (!name) {
    throw new Error(`No imported markdown metadata found for URI: ${localUri}`);
  }
  return name;
}

export async function deserializeMarkdownToNotebook(
  selection: LocalMarkdownSelection,
): Promise<parser_pb.Notebook> {
  try {
    return await aisreClientManager
      .get()
      .deserializeNotebook(selection.bytes);
  } catch (error) {
    console.warn("Failed to deserialize markdown via parser service", error);
    return createSingleMarkupCellNotebook(selection.text);
  }
}

export function toImportedNotebookName(markdownFileName: string): string {
  const trimmed = markdownFileName.trim();
  if (!trimmed) {
    return "imported-notebook.json";
  }

  const noPath = trimmed.split(/[\\/]/).pop() ?? trimmed;
  const withoutMdExtension = noPath.replace(/\.(runme\.)?md$/i, "").replace(/\.markdown$/i, "");
  const base = withoutMdExtension.trim() || "imported-notebook";

  if (/\.json$/i.test(base)) {
    return base;
  }
  return `${base}.json`;
}
