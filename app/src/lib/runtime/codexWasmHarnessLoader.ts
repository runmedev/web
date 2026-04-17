import { resolveAppUrl } from "../appBase";

export type BrowserInstructionOverrides = {
  base?: string;
  developer?: string;
  user?: string;
};

export type BrowserSessionOptions = {
  cwd?: string;
  instructions?: BrowserInstructionOverrides;
};

export type BrowserCodexInstance = {
  set_api_key(apiKey: string): void;
  setSessionOptions(options: BrowserSessionOptions): void;
  clearSessionOptions(): void;
  set_code_executor(executor: (input: string) => string | Promise<string>): void;
  clear_code_executor?(): void;
  submit_turn(prompt: string, onEvent: (event: unknown) => void): Promise<unknown>;
};

export type BrowserCodexConstructor = new (
  apiKey: string,
) => BrowserCodexInstance;

export type BrowserAppServerInstance = {
  set_api_key(apiKey: string): void;
  setSessionOptions(options: BrowserSessionOptions): void;
  clearSessionOptions(): void;
  setEventHandler(handler: (event: unknown) => void): void;
  clearEventHandler?(): void;
  set_code_executor(executor: (input: string) => string | Promise<string>): void;
  clear_code_executor?(): void;
  request(request: unknown): Promise<unknown>;
  notify(notification: unknown): Promise<void>;
  shutdown(): Promise<void>;
};

export type BrowserAppServerConstructor = new (
  apiKey: string,
) => BrowserAppServerInstance;

export type CodexWasmGeneratedModule = {
  default: (moduleOrPath?: string | URL | Request) => Promise<unknown>;
  BrowserCodex?: BrowserCodexConstructor;
  BrowserAppServer?: BrowserAppServerConstructor;
};

export function getCodexWasmAssetUrls(): { moduleUrl: string; wasmUrl: string } {
  return {
    moduleUrl: resolveAppUrl("generated/codex-wasm/codex_wasm_harness.js").toString(),
    wasmUrl: resolveAppUrl("generated/codex-wasm/codex_wasm_harness_bg.wasm").toString(),
  };
}

let modulePromise: Promise<CodexWasmGeneratedModule> | null = null;

export async function loadCodexWasmModule(): Promise<CodexWasmGeneratedModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const { moduleUrl, wasmUrl } = getCodexWasmAssetUrls();
      const generated = (await import(
        /* @vite-ignore */ moduleUrl
      )) as unknown as CodexWasmGeneratedModule;
      await generated.default(wasmUrl);
      return generated;
    })();
  }
  return modulePromise;
}

export function __resetCodexWasmHarnessLoaderForTests(): void {
  modulePromise = null;
}
