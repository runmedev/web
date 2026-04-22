import { getCodexExecuteApprovalManager } from "./codexExecuteApprovalManager";
import { getCodexAppServerClient } from "./codexAppServerClient";
import { createCodexChatKitAdapter } from "./codexChatKitAdapter";
import { getCodexConversationController } from "./codexConversationController";
import type { CodeModeExecutor } from "./codeModeExecutor";
import type { HarnessChatKitAdapter, HarnessRuntime } from "./harnessChatKitAdapter";
import {
  buildCodexAppServerWsUrl,
  buildCodexBridgeWsUrl,
  type HarnessProfile,
} from "./harnessManager";
import {
  getCodexToolBridge,
  type CodexToolBridgeHandler,
} from "./codexToolBridge";
import { createCodexWasmCodeExecutor } from "./codexWasmCodeExecutor";
import { buildRunmeCodexWasmSessionOptions } from "./runmeChatkitPrompts";

export type CreateCodexHarnessRuntimeOptions = {
  profile: HarnessProfile;
  projectId?: string;
  resolveAuthorization?: () => Promise<string>;
  codeModeExecutor?: CodeModeExecutor;
  codexBridgeHandler?: CodexToolBridgeHandler;
  wasmApiKey?: string;
};

function applyCodexProjectSelection(projectId?: string): void {
  if (!projectId) {
    return;
  }
  getCodexConversationController().setSelectedProject(projectId);
}

async function refreshCodexConversationState(): Promise<void> {
  const controller = getCodexConversationController();
  await controller.refreshHistory();
  await controller.ensureActiveThread();
}

function clearCodexClient(): void {
  const client = getCodexAppServerClient();
  client.setAuthorizationResolver(null);
  client.setCodeExecutor(null);
  client.disconnect();
}

function clearCodexBridge(
  cleanup: (() => void) | null,
  reason: string,
): null {
  const bridge = getCodexToolBridge();
  cleanup?.();
  bridge.setHandler(null);
  bridge.disconnect();
  getCodexExecuteApprovalManager().failAll(reason);
  return null;
}

function configureCodexBridge(options: {
  bridgeUrl: string;
  bridgeHandler?: CodexToolBridgeHandler;
  authorization: string;
}): () => void {
  const bridge = getCodexToolBridge();
  bridge.setHandler(options.bridgeHandler ?? null);
  const cleanup = bridge.subscribe(() => {
    const snapshot = bridge.getSnapshot();
    if (snapshot.state === "closed" || snapshot.state === "error") {
      getCodexExecuteApprovalManager().failAll("Codex bridge disconnected");
    }
  });
  void Promise.resolve(
    bridge.connect(options.bridgeUrl, options.authorization),
  ).catch(() => {
    // Bridge connection errors are surfaced through bridge snapshot state/logging.
  });
  return cleanup;
}

export class CodexProxyHarnessRuntime implements HarnessRuntime {
  readonly profile: HarnessProfile;
  private readonly options: CreateCodexHarnessRuntimeOptions;
  private readonly adapter: HarnessChatKitAdapter;
  private started = false;
  private bridgeSubscriptionCleanup: (() => void) | null = null;

  constructor(options: CreateCodexHarnessRuntimeOptions) {
    this.profile = options.profile;
    this.options = options;
    this.adapter = createCodexChatKitAdapter();
  }

  async start(): Promise<void> {
    applyCodexProjectSelection(this.options.projectId);
    if (this.started) {
      await refreshCodexConversationState();
      return;
    }

    const client = getCodexAppServerClient();
    try {
      client.setCodeExecutor(null);
      client.useTransport("proxy");
      client.setAuthorizationResolver(this.options.resolveAuthorization ?? null);
      const authorization = this.options.resolveAuthorization
        ? await this.options.resolveAuthorization()
        : "";
      await client.connectProxy(
        buildCodexAppServerWsUrl(this.profile.baseUrl),
        authorization,
      );
      this.bridgeSubscriptionCleanup = configureCodexBridge({
        bridgeUrl: buildCodexBridgeWsUrl(this.profile.baseUrl),
        bridgeHandler: this.options.codexBridgeHandler,
        authorization,
      });
      await refreshCodexConversationState();
      this.started = true;
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    this.bridgeSubscriptionCleanup = clearCodexBridge(
      this.bridgeSubscriptionCleanup,
      "Codex bridge disconnected",
    );
    clearCodexClient();
    this.started = false;
  }

  createChatKitAdapter(): HarnessChatKitAdapter {
    return this.adapter;
  }
}

export class CodexWasmHarnessRuntime implements HarnessRuntime {
  readonly profile: HarnessProfile;
  private readonly options: CreateCodexHarnessRuntimeOptions;
  private readonly adapter: HarnessChatKitAdapter;
  private started = false;

  constructor(options: CreateCodexHarnessRuntimeOptions) {
    this.profile = options.profile;
    this.options = options;
    this.adapter = createCodexChatKitAdapter();
  }

  async start(): Promise<void> {
    applyCodexProjectSelection(this.options.projectId);
    if (this.started) {
      await refreshCodexConversationState();
      return;
    }

    const client = getCodexAppServerClient();
    try {
      client.setCodeExecutor(
        this.options.codeModeExecutor
          ? createCodexWasmCodeExecutor({
              codeModeExecutor: this.options.codeModeExecutor,
            })
          : null,
      );
      client.useTransport("wasm");
      client.setAuthorizationResolver(null);
      await client.connectWasm({
        apiKey: this.options.wasmApiKey ?? "",
        sessionOptions: buildRunmeCodexWasmSessionOptions(),
      });
      clearCodexBridge(null, "Codex bridge disabled");
      await refreshCodexConversationState();
      this.started = true;
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    clearCodexBridge(null, "Codex bridge disconnected");
    clearCodexClient();
    this.started = false;
  }

  createChatKitAdapter(): HarnessChatKitAdapter {
    return this.adapter;
  }
}
