import type { HarnessProfile } from "./harnessManager";
import type { CodeModeExecutor } from "./codeModeExecutor";
import type { HarnessChatKitAdapter, HarnessRuntime } from "./harnessChatKitAdapter";
import type { ConversationController } from "./conversationController";
import {
  CodexProxyHarnessRuntime,
  CodexWasmHarnessRuntime,
} from "./codexHarnessRuntimes";
import type { CodexToolBridgeHandler } from "./codexToolBridge";
import {
  createResponsesDirectChatKitAdapter,
  createResponsesDirectConversationController,
} from "./responsesDirectChatKitAdapter";

export type CreateHarnessRuntimeOptions = {
  profile: HarnessProfile;
  projectId?: string;
  resolveAuthorization?: () => Promise<string>;
  codeModeExecutor?: CodeModeExecutor;
  codexBridgeHandler?: CodexToolBridgeHandler;
  wasmApiKey?: string;
  responsesApiBaseUrl?: string;
};

class ResponsesDirectHarnessRuntime implements HarnessRuntime {
  readonly profile: HarnessProfile;
  private readonly controller: ConversationController;
  private readonly adapter: HarnessChatKitAdapter;

  constructor(options: CreateHarnessRuntimeOptions) {
    this.profile = options.profile;
    this.controller = createResponsesDirectConversationController({
      responsesApiBaseUrl: options.responsesApiBaseUrl ?? options.profile.baseUrl,
      codeModeExecutor: options.codeModeExecutor,
    });
    this.adapter = createResponsesDirectChatKitAdapter(this.controller);
  }

  async start(): Promise<void> {}

  stop(): void {}

  getConversationController(): ConversationController {
    return this.controller;
  }

  createChatKitAdapter(): HarnessChatKitAdapter {
    return this.adapter;
  }
}

class HarnessRuntimeManager {
  private runtimes = new Map<
    string,
    {
      signature: string;
      runtime: HarnessRuntime;
      options: CreateHarnessRuntimeOptions;
    }
  >();

  private buildSignature(options: CreateHarnessRuntimeOptions): string {
    return JSON.stringify({
      profile: options.profile,
      projectId: options.projectId ?? null,
      responsesApiBaseUrl: options.responsesApiBaseUrl ?? null,
      wasmApiKey: options.wasmApiKey ?? null,
    });
  }

  private sameRuntimeInputs(
    left: CreateHarnessRuntimeOptions,
    right: CreateHarnessRuntimeOptions,
  ): boolean {
    return (
      left.codeModeExecutor === right.codeModeExecutor &&
      left.codexBridgeHandler === right.codexBridgeHandler &&
      left.resolveAuthorization === right.resolveAuthorization
    );
  }

  getOrCreate(options: CreateHarnessRuntimeOptions): HarnessRuntime {
    const signature = this.buildSignature(options);
    const existing = this.runtimes.get(options.profile.name);
    if (existing) {
      if (
        existing.signature === signature &&
        this.sameRuntimeInputs(existing.options, options)
      ) {
        return existing.runtime;
      }
      existing.runtime.stop();
      this.runtimes.delete(options.profile.name);
    }

    const runtime =
      options.profile.adapter === "responses-direct"
        ? new ResponsesDirectHarnessRuntime(options)
        : options.profile.adapter === "codex-wasm"
          ? new CodexWasmHarnessRuntime(options)
          : new CodexProxyHarnessRuntime(options);
    this.runtimes.set(options.profile.name, {
      signature,
      runtime,
      options,
    });
    return runtime;
  }

  reconcile(profile: HarnessProfile): void {
    const existing = this.runtimes.get(profile.name);
    if (!existing) {
      return;
    }
    const signature = JSON.stringify({
      profile,
      projectId: existing.options.projectId ?? null,
      responsesApiBaseUrl: existing.options.responsesApiBaseUrl ?? null,
      wasmApiKey: existing.options.wasmApiKey ?? null,
    });
    if (existing.signature === signature) {
      return;
    }
    existing.runtime.stop();
    this.runtimes.delete(profile.name);
  }

  remove(name: string): void {
    const existing = this.runtimes.get(name);
    if (!existing) {
      return;
    }
    existing.runtime.stop();
    this.runtimes.delete(name);
  }
}

let singleton: HarnessRuntimeManager | null = null;

export function getHarnessRuntimeManager(): HarnessRuntimeManager {
  if (!singleton) {
    singleton = new HarnessRuntimeManager();
  }
  return singleton;
}
