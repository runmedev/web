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

export function getCodexWasmAssetUrls(): { moduleUrl: string; wasmUrl: string } {
  return {
    moduleUrl: resolveAppUrl("generated/codex-wasm/codex_wasm_harness.js").toString(),
    wasmUrl: resolveAppUrl("generated/codex-wasm/codex_wasm_harness_bg.wasm").toString(),
  };
}
