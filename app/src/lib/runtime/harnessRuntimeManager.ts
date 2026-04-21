import { buildCodexAppServerWsUrl, buildCodexBridgeWsUrl, type HarnessProfile } from "./harnessManager";
import type { CodeModeExecutor } from "./codeModeExecutor";
import { createCodexChatKitAdapter } from "./codexChatkitFetch";
import { getCodexHarnessBootstrap } from "./codexHarnessBootstrap";
import type { HarnessChatKitAdapter, HarnessRuntime } from "./harnessChatKitAdapter";
import type { CodexToolBridgeHandler } from "./codexToolBridge";
import { createCodexWasmCodeExecutor } from "./codexWasmCodeExecutor";
import { buildRunmeCodexWasmSessionOptions } from "./runmeChatkitPrompts";
import { createResponsesDirectChatKitAdapter } from "./responsesDirectChatkitFetch";

export type CreateHarnessRuntimeOptions = {
  profile: HarnessProfile;
  projectId?: string;
  resolveAuthorization?: () => Promise<string>;
  codeModeExecutor?: CodeModeExecutor;
  codexBridgeHandler?: CodexToolBridgeHandler;
  wasmApiKey?: string;
  responsesApiBaseUrl?: string;
  clientToolInvoker?: HarnessChatKitAdapter["invokeClientTool"];
};

class ResponsesDirectHarnessRuntime implements HarnessRuntime {
  readonly profile: HarnessProfile;
  private readonly adapter: HarnessChatKitAdapter;

  constructor(options: CreateHarnessRuntimeOptions) {
    this.profile = options.profile;
    this.adapter = createResponsesDirectChatKitAdapter({
      responsesApiBaseUrl: options.responsesApiBaseUrl ?? options.profile.baseUrl,
    });
    this.adapter.invokeClientTool = options.clientToolInvoker;
  }

  async start(): Promise<void> {}

  stop(): void {}

  createChatKitAdapter(): HarnessChatKitAdapter {
    return this.adapter;
  }
}

class CodexHarnessRuntime implements HarnessRuntime {
  readonly profile: HarnessProfile;
  private readonly options: CreateHarnessRuntimeOptions;
  private readonly adapter: HarnessChatKitAdapter;

  constructor(options: CreateHarnessRuntimeOptions) {
    this.profile = options.profile;
    this.options = options;
    this.adapter = createCodexChatKitAdapter();
  }

  async start(): Promise<void> {
    const mode = this.profile.adapter === "codex-wasm" ? "codex-wasm" : "codex";
    await getCodexHarnessBootstrap().start({
      mode,
      projectId: this.options.projectId,
      proxyUrl:
        mode === "codex" ? buildCodexAppServerWsUrl(this.profile.baseUrl) : undefined,
      bridgeUrl:
        mode === "codex" ? buildCodexBridgeWsUrl(this.profile.baseUrl) : undefined,
      resolveAuthorization: mode === "codex" ? this.options.resolveAuthorization : undefined,
      bridgeHandler: mode === "codex" ? this.options.codexBridgeHandler : undefined,
      wasmApiKey: mode === "codex-wasm" ? this.options.wasmApiKey ?? "" : undefined,
      wasmSessionOptions:
        mode === "codex-wasm" ? buildRunmeCodexWasmSessionOptions() : undefined,
      wasmCodeExecutor:
        mode === "codex-wasm" && this.options.codeModeExecutor
          ? createCodexWasmCodeExecutor({
              codeModeExecutor: this.options.codeModeExecutor,
            })
          : null,
    });
  }

  stop(): void {
    getCodexHarnessBootstrap().stop();
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
      left.resolveAuthorization === right.resolveAuthorization &&
      left.clientToolInvoker === right.clientToolInvoker
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
        : new CodexHarnessRuntime(options);
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
