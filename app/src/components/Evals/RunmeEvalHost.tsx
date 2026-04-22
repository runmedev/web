import { create } from "@bufbuild/protobuf";
import { useEffect, useMemo, useRef } from "react";

import { useCurrentDoc } from "../../contexts/CurrentDocContext";
import { useNotebookContext } from "../../contexts/NotebookContext";
import { useOutput } from "../../contexts/OutputContext";
import { parser_pb } from "../../runme/client";
import { LOCAL_FOLDER_URI } from "../../storage/local";
import { getAuthData } from "../../token";
import { appState } from "../../lib/runtime/AppState";
import {
  getCodexAppServerClient,
  type CodexProxyJsonRpcNotification,
} from "../../lib/runtime/codexAppServerClient";
import { useCodexProjects } from "../../lib/runtime/codexProjectManager";
import { getCodexWasmAppServerClient } from "../../lib/runtime/codexWasmAppServerClient";
import type { HarnessChatKitAdapter } from "../../lib/runtime/harnessChatKitAdapter";
import { getHarnessRuntimeManager } from "../../lib/runtime/harnessRuntimeManager";
import type { HarnessAdapter, HarnessProfile } from "../../lib/runtime/harnessManager";
import { createCodexBridgeToolHandler } from "../../lib/runtime/notebookToolHandlers";
import { createAppKernelOpfsApi } from "../../lib/runtime/appKernelLowLevelApis";
import { buildPageCodeModeExecutor } from "../../lib/runtime/pageCodeModeExecutor";
import {
  responsesDirectConfigManager,
  useResponsesDirectConfigSnapshot,
} from "../../lib/runtime/responsesDirectConfigManager";
import type { ChatKitStreamEvent } from "../../lib/runtime/chatkitProtocol";

type EvalNotebookCellInput = {
  refId?: string;
  languageId?: string;
  value?: string;
  metadata?: Record<string, string>;
};

type CreateEvalNotebookOptions = {
  name: string;
  cells?: EvalNotebookCellInput[];
  open?: boolean;
};

type RunEvalOptions = {
  harness: {
    adapter: HarnessAdapter;
    name?: string;
    baseUrl?: string;
  };
  prompt: string;
  notebookUri?: string | null;
  projectId?: string;
  model?: string;
  timeoutMs?: number;
  wasmApiKey?: string;
  responsesApiBaseUrl?: string;
  inspectOpfsPath?: string | null;
};

type EvalRequestRecord = {
  timestamp: string;
  method: string;
  params?: unknown;
};

type EvalOpfsEntry = {
  path: string;
  kind: "file" | "directory";
  size?: number;
};

type RunEvalResult = {
  harness: HarnessProfile;
  prompt: string;
  threadId: string | null;
  events: ChatKitStreamEvent[];
  assistantText: string;
  requestLog: EvalRequestRecord[];
  notifications: CodexProxyJsonRpcNotification[];
  wasmJournal: unknown[];
  notebook:
    | {
        uri: string;
        name: string;
        cells: Array<{
          refId: string;
          languageId: string;
          value: string;
        }>;
      }
    | null;
  opfs: EvalOpfsEntry[];
  metrics: {
    ttfmMs: number | null;
    turnTimeMs: number;
  };
};

type RunmeEvalApi = {
  waitUntilReady(timeoutMs?: number): Promise<true>;
  configureResponsesDirect(options: {
    authMethod?: "oauth" | "api_key";
    apiKey?: string;
    openaiOrganization?: string;
    openaiProject?: string;
  }): Promise<void>;
  createLocalNotebook(options: CreateEvalNotebookOptions): Promise<{ uri: string }>;
  openNotebook(uri: string): Promise<void>;
  run(options: RunEvalOptions): Promise<RunEvalResult>;
};

declare global {
  interface Window {
    __runmeEval?: RunmeEvalApi;
  }
}

function buildHarnessProfile(input: RunEvalOptions["harness"]): HarnessProfile {
  const baseUrl =
    input.baseUrl ??
    (input.adapter === "responses-direct"
      ? "https://api.openai.com"
      : "http://127.0.0.1:19989");
  return {
    name:
      input.name ??
      `${input.adapter}-eval`,
    adapter: input.adapter,
    baseUrl,
  };
}

function buildNotebook(
  cells: EvalNotebookCellInput[] | undefined,
): parser_pb.Notebook {
  return create(parser_pb.NotebookSchema, {
    metadata: {},
    cells: (cells ?? []).map((cell, index) =>
      create(parser_pb.CellSchema, {
        refId:
          cell.refId ??
          `eval_cell_${index + 1}_${Math.random().toString(36).slice(2, 8)}`,
        kind: parser_pb.CellKind.CODE,
        role: parser_pb.CellRole.USER,
        languageId: cell.languageId ?? "python",
        value: cell.value ?? "",
        metadata: cell.metadata ?? {},
        outputs: [],
      }),
    ),
  });
}

function extractAssistantText(events: ChatKitStreamEvent[]): string {
  const chunks: string[] = [];
  const textByItem = new Map<string, string>();
  for (const event of events) {
    if (event.type === "response.output_text.delta") {
      chunks.push(event.delta);
      continue;
    }
    if (
      event.type === "thread.item.updated" &&
      event.update.type === "assistant_message.content_part.text_delta"
    ) {
      const next = `${textByItem.get(event.item_id) ?? ""}${event.update.delta}`;
      textByItem.set(event.item_id, next);
      continue;
    }
    if (
      event.type === "thread.item.updated" &&
      event.update.type === "assistant_message.content_part.done"
    ) {
      textByItem.set(event.item_id, event.update.content.text);
      continue;
    }
    if (
      event.type === "thread.item.done" &&
      event.item.type === "assistant_message"
    ) {
      const text = event.item.content
        .map((part) => ("text" in part ? part.text : ""))
        .join("");
      if (text) {
        chunks.length = 0;
        chunks.push(text);
      }
    }
  }
  if (chunks.length === 0 && textByItem.size > 0) {
    return Array.from(textByItem.values()).join("\n");
  }
  return chunks.join("");
}

function eventStartsAssistantOutput(event: ChatKitStreamEvent): boolean {
  if (event.type === "response.output_text.delta" && event.delta.trim()) {
    return true;
  }
  if (
    event.type === "thread.item.updated" &&
    event.update.type === "assistant_message.content_part.text_delta" &&
    event.update.delta.trim()
  ) {
    return true;
  }
  if (
    event.type === "thread.item.added" &&
    event.item.type === "assistant_message"
  ) {
    return event.item.content.some(
      (part) => "text" in part && part.text.trim().length > 0,
    );
  }
  return false;
}

async function listOpfsTree(path: string | null | undefined): Promise<EvalOpfsEntry[]> {
  if (!path) {
    return [];
  }
  const opfs = createAppKernelOpfsApi();
  if (!(await opfs.exists(path))) {
    return [];
  }
  const results: EvalOpfsEntry[] = [];
  const visit = async (currentPath: string) => {
    const stat = await opfs.stat(currentPath);
    results.push({
      path: currentPath,
      kind: stat.kind,
      size: stat.size,
    });
    if (stat.kind !== "directory") {
      return;
    }
    const entries = await opfs.list(currentPath);
    for (const entry of entries) {
      const childPath =
        currentPath === "/"
          ? `/${entry.name}`
          : `${currentPath.replace(/\/+$/, "")}/${entry.name}`;
      await visit(childPath);
    }
  };
  await visit(path);
  return results.sort((left, right) => left.path.localeCompare(right.path));
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

export function RunmeEvalHost() {
  const { getNotebookData, useNotebookList } = useNotebookContext();
  const { getCurrentDoc, setCurrentDoc } = useCurrentDoc();
  const { getAllRenderers } = useOutput();
  const openNotebookList = useNotebookList();
  const responsesDirectConfig = useResponsesDirectConfigSnapshot();
  const codexProjects = useCodexProjects();

  const getNotebookDataRef = useRef(getNotebookData);
  getNotebookDataRef.current = getNotebookData;
  const getCurrentDocRef = useRef(getCurrentDoc);
  getCurrentDocRef.current = getCurrentDoc;
  const setCurrentDocRef = useRef(setCurrentDoc);
  setCurrentDocRef.current = setCurrentDoc;
  const openNotebookListRef = useRef(openNotebookList);
  openNotebookListRef.current = openNotebookList;
  const getAllRenderersRef = useRef(getAllRenderers);
  getAllRenderersRef.current = getAllRenderers;
  const responsesDirectConfigRef = useRef(responsesDirectConfig);
  responsesDirectConfigRef.current = responsesDirectConfig;
  const defaultProjectIdRef = useRef(codexProjects.defaultProject.id);
  defaultProjectIdRef.current = codexProjects.defaultProject.id;

  const codeModeExecutor = useMemo(
    () =>
      buildPageCodeModeExecutor({
        getNotebookData: (uri) => getNotebookDataRef.current(uri),
        getOpenNotebookUris: () =>
          openNotebookListRef.current.map((item) => item.uri),
        getCurrentDocUri: () => getCurrentDocRef.current(),
        getRenderers: () => getAllRenderersRef.current().values(),
      }),
    [],
  );

  const codexBridgeHandler = useMemo(
    () =>
      createCodexBridgeToolHandler({
        codeModeExecutor,
      }),
    [codeModeExecutor],
  );

  useEffect(() => {
    const api: RunmeEvalApi = {
      async waitUntilReady(timeoutMs = 15000) {
        await waitForCondition(
          () => Boolean(appState.localNotebooks),
          timeoutMs,
        );
        return true;
      },
      async configureResponsesDirect(options) {
        if (options.authMethod) {
          responsesDirectConfigManager.setAuthMethod(options.authMethod);
        }
        if (typeof options.apiKey === "string") {
          responsesDirectConfigManager.setAPIKey(options.apiKey);
        }
        if (typeof options.openaiOrganization === "string") {
          responsesDirectConfigManager.setOpenAIOrganization(
            options.openaiOrganization,
          );
        }
        if (typeof options.openaiProject === "string") {
          responsesDirectConfigManager.setOpenAIProject(options.openaiProject);
        }
      },
      async createLocalNotebook(options) {
        if (!appState.localNotebooks) {
          throw new Error("Local notebook store is not initialized yet.");
        }
        const created = await appState.localNotebooks.create(
          LOCAL_FOLDER_URI,
          options.name,
        );
        await appState.localNotebooks.save(
          created.uri,
          buildNotebook(options.cells),
        );
        if (options.open !== false) {
          setCurrentDocRef.current(created.uri);
          await waitForCondition(() => {
            const data = getNotebookDataRef.current(created.uri);
            return Boolean(data?.getSnapshot().loaded);
          }, 15000);
        }
        return { uri: created.uri };
      },
      async openNotebook(uri) {
        setCurrentDocRef.current(uri);
        await waitForCondition(() => {
          const data = getNotebookDataRef.current(uri);
          return Boolean(data?.getSnapshot().loaded);
        }, 15000);
      },
      async run(options) {
        const harnessRuntimeManager = getHarnessRuntimeManager();
        const profile = buildHarnessProfile(options.harness);
        const runtime = harnessRuntimeManager.getOrCreate({
          profile,
          projectId: options.projectId ?? defaultProjectIdRef.current,
          resolveAuthorization:
            profile.adapter === "codex"
              ? async () => {
                  const authData = await getAuthData();
                  const idToken = authData?.idToken?.trim();
                  if (idToken) {
                    return `Bearer ${idToken}`;
                  }
                  const isLocalFakeHarness =
                    profile.baseUrl.includes("127.0.0.1") ||
                    profile.baseUrl.includes("localhost");
                  return isLocalFakeHarness ? "Bearer eval-test-token" : "";
                }
              : undefined,
          codeModeExecutor,
          codexBridgeHandler:
            profile.adapter === "codex" ? codexBridgeHandler : undefined,
          wasmApiKey:
            profile.adapter === "codex-wasm"
              ? options.wasmApiKey ??
                responsesDirectConfigRef.current.apiKey ??
                ""
              : undefined,
          responsesApiBaseUrl:
            profile.adapter === "responses-direct"
              ? options.responsesApiBaseUrl ?? profile.baseUrl
              : undefined,
        });

        const events: ChatKitStreamEvent[] = [];
        const requestLog: EvalRequestRecord[] = [];
        const notifications: CodexProxyJsonRpcNotification[] = [];
        const client = getCodexAppServerClient();
        const originalSendRequest = client.sendRequest.bind(client);
        const instrumentedSendRequest = async <T,>(
          method: string,
          params?: unknown,
        ): Promise<T> => {
          requestLog.push({
            timestamp: new Date().toISOString(),
            method,
            params,
          });
          return await originalSendRequest<T>(method, params);
        };
        client.sendRequest = instrumentedSendRequest as typeof client.sendRequest;
        const unsubscribeNotifications = client.subscribeNotifications(
          (notification) => {
            notifications.push(notification);
          },
        );

        const adapter = runtime.createChatKitAdapter();
        const startTime = performance.now();
        let ttfmMs: number | null = null;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const abortController = new AbortController();

        try {
          if (options.notebookUri) {
            await api.openNotebook(options.notebookUri);
          }
          await runtime.start();
          await Promise.race([
            adapter.streamUserMessage(
              {
                input: options.prompt,
                model: options.model,
                signal: abortController.signal,
              },
              {
                emit(event) {
                  events.push(event);
                  if (ttfmMs === null && eventStartsAssistantOutput(event)) {
                    ttfmMs = performance.now() - startTime;
                  }
                },
              },
            ),
            new Promise<never>((_, reject) => {
              timeoutId = setTimeout(() => {
                abortController.abort();
                reject(
                  new Error(
                    `Eval turn timed out after ${options.timeoutMs ?? 45000}ms`,
                  ),
                );
              }, options.timeoutMs ?? 45000);
            }),
          ]);

          const turnTimeMs = performance.now() - startTime;
          const threadId = adapter.initialThreadId ?? null;
          const notebookUri =
            options.notebookUri ?? getCurrentDocRef.current() ?? null;
          const notebookData = notebookUri
            ? getNotebookDataRef.current(notebookUri)
            : undefined;
          const notebookSnapshot = notebookData?.getSnapshot() ?? null;

          return {
            harness: profile,
            prompt: options.prompt,
            threadId,
            events,
            assistantText: extractAssistantText(events),
            requestLog,
            notifications,
            wasmJournal:
              profile.adapter === "codex-wasm"
                ? await getCodexWasmAppServerClient().getEventJournal()
                : [],
            notebook: notebookSnapshot
              ? {
                  uri: notebookSnapshot.uri,
                  name: notebookSnapshot.name,
                  cells: notebookSnapshot.notebook.cells.map((cell) => ({
                    refId: cell.refId,
                    languageId: cell.languageId,
                    value: cell.value ?? "",
                  })),
                }
              : null,
            opfs: await listOpfsTree(options.inspectOpfsPath),
            metrics: {
              ttfmMs,
              turnTimeMs,
            },
          };
        } finally {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          unsubscribeNotifications();
          client.sendRequest = originalSendRequest;
          runtime.stop();
          harnessRuntimeManager.remove(profile.name);
        }
      },
    };

    window.__runmeEval = api;
    return () => {
      if (window.__runmeEval === api) {
        delete window.__runmeEval;
      }
    };
  }, [codeModeExecutor, codexBridgeHandler]);

  return null;
}
