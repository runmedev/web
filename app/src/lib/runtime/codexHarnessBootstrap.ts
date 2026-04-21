import { getCodexExecuteApprovalManager } from "./codexExecuteApprovalManager";
import { getCodexAppServerClient } from "./codexAppServerClient";
import { getCodexConversationController } from "./codexConversationController";
import { getCodexToolBridge, type CodexToolBridgeHandler } from "./codexToolBridge";
import type { BrowserSessionOptions } from "./codexWasmHarnessLoader";
import type { CodexWasmCodeExecutor } from "./codexWasmWorkerClient";

export type CodexHarnessMode = "codex" | "codex-wasm";

export type StartCodexHarnessOptions = {
  mode: CodexHarnessMode;
  projectId?: string;
  proxyUrl?: string;
  bridgeUrl?: string;
  resolveAuthorization?: () => Promise<string>;
  wasmApiKey?: string;
  wasmSessionOptions?: BrowserSessionOptions;
  wasmCodeExecutor?: CodexWasmCodeExecutor | null;
  bridgeHandler?: CodexToolBridgeHandler | null;
};

export type StartCodexHarnessResult = {
  threadId: string;
  previousResponseId?: string | null;
};

class CodexHarnessBootstrap {
  private currentKey: string | null = null;
  private bridgeSubscriptionCleanup: (() => void) | null = null;

  async start(options: StartCodexHarnessOptions): Promise<StartCodexHarnessResult> {
    const key = JSON.stringify({
      mode: options.mode,
      projectId: options.projectId ?? null,
      proxyUrl: options.proxyUrl ?? null,
      bridgeUrl: options.bridgeUrl ?? null,
      wasmApiKey: options.wasmApiKey ?? null,
    });

    if (this.currentKey && this.currentKey !== key) {
      this.stop();
    }

    const controller = getCodexConversationController();
    const client = getCodexAppServerClient();

    if (options.projectId) {
      controller.setSelectedProject(options.projectId);
    }

    if (this.currentKey === key) {
      await controller.refreshHistory();
      const thread = await controller.ensureActiveThread();
      return {
        threadId: thread.id,
        previousResponseId: thread.previousResponseId ?? null,
      };
    }

    if (options.mode === "codex-wasm") {
      client.setCodeExecutor(options.wasmCodeExecutor ?? null);
      client.useTransport("wasm");
      client.setAuthorizationResolver(null);
      await client.connectWasm({
        apiKey: options.wasmApiKey ?? "",
        sessionOptions: options.wasmSessionOptions,
      });
      this.configureBridge({
        enabled: false,
      });
    } else {
      client.setCodeExecutor(null);
      client.useTransport("proxy");
      client.setAuthorizationResolver(options.resolveAuthorization ?? null);
      const authorization = options.resolveAuthorization
        ? await options.resolveAuthorization()
        : "";
      await client.connectProxy(options.proxyUrl ?? "", authorization);
      this.configureBridge({
        enabled: true,
        bridgeUrl: options.bridgeUrl,
        bridgeHandler: options.bridgeHandler ?? null,
        authorization,
      });
    }

    await controller.refreshHistory();
    const thread = await controller.ensureActiveThread();
    this.currentKey = key;
    return {
      threadId: thread.id,
      previousResponseId: thread.previousResponseId ?? null,
    };
  }

  stop(): void {
    const bridge = getCodexToolBridge();
    this.bridgeSubscriptionCleanup?.();
    this.bridgeSubscriptionCleanup = null;
    bridge.setHandler(null);
    bridge.disconnect();
    getCodexExecuteApprovalManager().failAll("Codex bridge disconnected");

    const client = getCodexAppServerClient();
    client.setAuthorizationResolver(null);
    client.setCodeExecutor(null);
    client.disconnect();
    this.currentKey = null;
  }

  private configureBridge(options: {
    enabled: boolean;
    bridgeUrl?: string;
    bridgeHandler?: CodexToolBridgeHandler | null;
    authorization?: string;
  }): void {
    const bridge = getCodexToolBridge();
    this.bridgeSubscriptionCleanup?.();
    this.bridgeSubscriptionCleanup = null;

    if (!options.enabled) {
      bridge.setHandler(null);
      bridge.disconnect();
      getCodexExecuteApprovalManager().failAll("Codex bridge disabled");
      return;
    }

    bridge.setHandler(options.bridgeHandler ?? null);
    this.bridgeSubscriptionCleanup = bridge.subscribe(() => {
      const snapshot = bridge.getSnapshot();
      if (snapshot.state === "closed" || snapshot.state === "error") {
        getCodexExecuteApprovalManager().failAll("Codex bridge disconnected");
      }
    });
    if (options.bridgeUrl && options.authorization) {
      void Promise.resolve(bridge.connect(options.bridgeUrl, options.authorization)).catch(
        () => {
          // Bridge connection errors are surfaced through bridge snapshot state/logging.
        },
      );
    }
  }
}

let singleton: CodexHarnessBootstrap | null = null;

export function getCodexHarnessBootstrap(): CodexHarnessBootstrap {
  if (!singleton) {
    singleton = new CodexHarnessBootstrap();
  }
  return singleton;
}
