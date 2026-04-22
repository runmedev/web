import { parser_pb } from "../../contexts/CellContext";
import type { OutputRenderer } from "../../contexts/OutputContext";
import type { NotebookData } from "../notebookData";
import {
  createCodeModeExecutor,
  type CodeModeExecutor,
} from "./codeModeExecutor";
import type { NotebookDataLike } from "./runmeConsole";

type NotebookTargetLike =
  | string
  | { uri?: string }
  | { handle?: { uri?: string } }
  | undefined;

export type BuildPageCodeModeExecutorOptions = {
  getNotebookData: (uri: string) => NotebookData | undefined;
  getOpenNotebookUris: () => string[];
  getCurrentDocUri: () => string | null;
  getRenderers: () => Iterable<OutputRenderer>;
};

function resolveTargetUri(
  target: NotebookTargetLike,
  getCurrentDocUri: () => string | null,
): string | null {
  if (typeof target === "string" && target.trim()) {
    return target;
  }
  if (
    target &&
    typeof target === "object" &&
    "uri" in target &&
    typeof target.uri === "string" &&
    target.uri.trim()
  ) {
    return target.uri;
  }
  if (
    target &&
    typeof target === "object" &&
    "handle" in target &&
    target.handle &&
    typeof target.handle.uri === "string" &&
    target.handle.uri.trim()
  ) {
    return target.handle.uri;
  }
  return getCurrentDocUri();
}

function toNotebookDataLike(
  data: NotebookData,
  getRenderers: () => Iterable<OutputRenderer>,
): NotebookDataLike {
  return {
    getUri: () => data.getUri(),
    getName: () => data.getName(),
    getNotebook: () => data.getNotebook(),
    updateCell: (cell: parser_pb.Cell) => {
      for (const renderer of getRenderers()) {
        renderer.onCellUpdate(cell);
      }
      data.updateCell(cell);
    },
    getCell: (refId: string) => data.getCell(refId),
    appendCodeCell: data.appendCodeCell?.bind(data),
    addCodeCellAfter: data.addCodeCellAfter?.bind(data),
    addCodeCellBefore: data.addCodeCellBefore?.bind(data),
    removeCell: data.removeCell?.bind(data),
  };
}

export function createPageNotebookResolver(
  options: BuildPageCodeModeExecutorOptions,
): (target?: unknown) => NotebookDataLike | null {
  return (target?: unknown) => {
    const targetUri = resolveTargetUri(
      target as NotebookTargetLike,
      options.getCurrentDocUri,
    );
    if (!targetUri) {
      return null;
    }
    const data = options.getNotebookData(targetUri);
    if (!data) {
      return null;
    }
    return toNotebookDataLike(data, options.getRenderers);
  };
}

export function listPageNotebooks(
  options: BuildPageCodeModeExecutorOptions,
  resolveNotebook: (target?: unknown) => NotebookDataLike | null,
): NotebookDataLike[] {
  const uris = new Set<string>();
  for (const uri of options.getOpenNotebookUris()) {
    if (typeof uri === "string" && uri.trim()) {
      uris.add(uri);
    }
  }
  const currentDocUri = options.getCurrentDocUri();
  if (currentDocUri) {
    uris.add(currentDocUri);
  }
  return Array.from(uris)
    .map((uri) => resolveNotebook(uri))
    .filter((notebook): notebook is NotebookDataLike => Boolean(notebook));
}

export function buildPageCodeModeExecutor(
  options: BuildPageCodeModeExecutorOptions,
): CodeModeExecutor {
  const resolveNotebook = createPageNotebookResolver(options);
  return createCodeModeExecutor({
    mode: "sandbox",
    resolveNotebook,
    listNotebooks: () => listPageNotebooks(options, resolveNotebook),
  });
}
