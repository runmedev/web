import { getCodexAppServerClient } from "./codexAppServerClient";
import { createCodexChatKitAdapter } from "./codexChatKitAdapter";
import { getCodexConversationController } from "./codexConversationController";
import { type CodexToolBridgeHandler, getCodexToolBridge } from "./codexToolBridge";
import type { ConversationController } from "./conversationController";
import type { HarnessChatKitAdapter, HarnessRuntime } from "./harnessChatKitAdapter";
import {
  type HarnessProfile,
  buildCodexAppServerWsUrl,
  buildCodexBridgeWsUrl,
} from "./harnessManager";

export type CreateCodexHarnessRuntimeOptions = {
  profile: HarnessProfile;
  projectId?: string;
  resolveAuthorization?: () => Promise<string>;
  codexBridgeHandler?: CodexToolBridgeHandler;
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
}

function clearCodexClient(): void {
  const client = getCodexAppServerClient();
  client.setAuthorizationResolver(null);
  client.disconnect();
}

function clearCodexBridge(cleanup: (() => void) | null): null {
  const bridge = getCodexToolBridge();
  cleanup?.();
  bridge.setHandler(null);
  bridge.disconnect();
  return null;
}

function configureCodexBridge(options: {
  bridgeUrl: string;
  bridgeHandler?: CodexToolBridgeHandler;
  authorization: string;
}): () => void {
  const bridge = getCodexToolBridge();
  bridge.setHandler(options.bridgeHandler ?? null);
  void Promise.resolve(bridge.connect(options.bridgeUrl, options.authorization)).catch(() => {
    // Bridge connection errors are surfaced through bridge snapshot state/logging.
  });
  return () => {
    bridge.setHandler(null);
    bridge.disconnect();
  };
}

export class CodexProxyHarnessRuntime implements HarnessRuntime {
  readonly profile: HarnessProfile;
  private readonly options: CreateCodexHarnessRuntimeOptions;
  private readonly controller: ConversationController;
  private readonly adapter: HarnessChatKitAdapter;
  private started = false;
  private bridgeSubscriptionCleanup: (() => void) | null = null;

  constructor(options: CreateCodexHarnessRuntimeOptions) {
    this.profile = options.profile;
    this.options = options;
    this.controller = getCodexConversationController();
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
      client.setAuthorizationResolver(this.options.resolveAuthorization ?? null);
      const authorization = this.options.resolveAuthorization
        ? await this.options.resolveAuthorization()
        : "";
      await client.connectProxy(buildCodexAppServerWsUrl(this.profile.baseUrl), authorization);
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
    this.bridgeSubscriptionCleanup = clearCodexBridge(this.bridgeSubscriptionCleanup);
    clearCodexClient();
    this.started = false;
  }

  getConversationController(): ConversationController {
    return this.controller;
  }

  createChatKitAdapter(): HarnessChatKitAdapter {
    return this.adapter;
  }
}
