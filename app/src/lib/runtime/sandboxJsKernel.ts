import { appLogger } from "../logging/runtime";
import { SANDBOX_NOTEBOOKS_API_METHODS } from "./notebooksApiBridge";

type KernelHooks = {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  onExit?: (exitCode: number) => void;
};

type SandboxBridge = {
  call: (method: string, args: unknown[]) => Promise<unknown> | unknown;
};

type SandboxMessage =
  | { type: "ready" }
  | { type: "stdout"; data?: string }
  | { type: "stderr"; data?: string }
  | { type: "exit"; exitCode?: number }
  | { type: "host-call"; callId?: number; method?: string; args?: unknown[] };

type SandboxSession = {
  iframe: HTMLIFrameElement;
  port: MessagePort;
  dispose: () => void;
};

const SANDBOX_INIT_MESSAGE = "runme-appkernel-sandbox-init";
const LOAD_TIMEOUT_MS = 3_000;
const READY_TIMEOUT_MS = 3_000;

const SANDBOX_SRC_DOC = `<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>
    <script>
      (() => {
        let port = null;
        let callCounter = 0;
        const pending = new Map();

        const formatArgs = (args) =>
          args
            .map((value) => {
              if (typeof value === "string") {
                return value;
              }
              try {
                return JSON.stringify(
                  value,
                  (_key, item) => (typeof item === "bigint" ? item.toString() : item),
                );
              } catch {
                return String(value);
              }
            })
            .join(" ") + "\\n";

        const post = (payload) => {
          if (!port) {
            return;
          }
          port.postMessage(payload);
        };

        const hostCall = (method, args = []) =>
          new Promise((resolve, reject) => {
            if (!port) {
              reject(new Error("Sandbox host bridge is unavailable."));
              return;
            }
            callCounter += 1;
            const callId = callCounter;
            pending.set(callId, { resolve, reject });
            post({ type: "host-call", callId, method, args });
          });

        const consoleProxy = {
          log: (...args) => post({ type: "stdout", data: formatArgs(args) }),
          info: (...args) => post({ type: "stdout", data: formatArgs(args) }),
          warn: (...args) => post({ type: "stderr", data: formatArgs(args) }),
          error: (...args) => post({ type: "stderr", data: formatArgs(args) }),
        };

        const runme = {
          clear: (target) => hostCall("runme.clear", [target]),
          clearOutputs: (target) => hostCall("runme.clearOutputs", [target]),
          runAll: (target) => hostCall("runme.runAll", [target]),
          rerun: (target) => hostCall("runme.rerun", [target]),
          getCurrentNotebook: () => hostCall("runme.getCurrentNotebook", []),
          help: () => hostCall("runme.help", []),
        };

        const createSandboxNotebooksApiClient = (callHost) => ({
          help: (topic) => callHost("notebooks.help", [topic]),
          list: (query) => callHost("notebooks.list", [query]),
          get: (target) => callHost("notebooks.get", [target]),
          update: (args) => callHost("notebooks.update", [args]),
          delete: (target) => callHost("notebooks.delete", [target]),
          execute: (args) => callHost("notebooks.execute", [args]),
        });

        const notebooks = createSandboxNotebooksApiClient(hostCall);

        const help = () => {
          consoleProxy.log("Sandbox JS helpers:");
          consoleProxy.log("- runme.clear([target])");
          consoleProxy.log("- runme.clearOutputs([target])");
          consoleProxy.log("- runme.runAll([target])");
          consoleProxy.log("- runme.rerun([target])");
          consoleProxy.log("- runme.getCurrentNotebook()");
          consoleProxy.log("- runme.help()");
          consoleProxy.log("- notebooks.help([topic])");
          consoleProxy.log("- notebooks.list([query])");
          consoleProxy.log("- notebooks.get([target])");
          consoleProxy.log("- notebooks.update({ target?, expectedRevision?, operations })");
          consoleProxy.log("- notebooks.execute({ target?, refIds })");
          consoleProxy.log("- help()");
        };

        const run = async (code) => {
          let exitCode = 0;
          try {
            const runner = new Function(
              "console",
              "runme",
              "notebooks",
              "help",
              '"use strict"; return (async () => {\\n' + code + '\\n})();',
            );
            await runner(consoleProxy, runme, notebooks, help);
          } catch (error) {
            exitCode = 1;
            post({ type: "stderr", data: String(error) + "\\n" });
          } finally {
            post({ type: "exit", exitCode });
          }
        };

        window.addEventListener(
          "message",
          (event) => {
            const data = event.data ?? {};
            if (data.type !== "${SANDBOX_INIT_MESSAGE}") {
              return;
            }
            const transferred = event.ports?.[0];
            if (!transferred) {
              return;
            }
            port = transferred;
            port.onmessage = (innerEvent) => {
              const payload = innerEvent.data ?? {};
              if (payload.type === "run") {
                void run(String(payload.code ?? ""));
                return;
              }
              const callId = Number(payload.callId ?? 0);
              if (!callId || !pending.has(callId)) {
                return;
              }
              const callbacks = pending.get(callId);
              pending.delete(callId);
              if (payload.type === "host-result") {
                callbacks.resolve(payload.result);
                return;
              }
              if (payload.type === "host-error") {
                callbacks.reject(new Error(String(payload.error ?? "Host call failed")));
              }
            };
            if (typeof port.start === "function") {
              port.start();
            }
            post({ type: "ready" });
          },
          { once: true },
        );
      })();
    </script>
  </body>
</html>`;

/**
 * SandboxJSKernel executes JavaScript in a sandboxed iframe and only exposes a
 * small RPC bridge back to the host. Code running here cannot access the main
 * window realm directly.
 */
export class SandboxJSKernel {
  private readonly hooks: Required<KernelHooks>;
  private readonly bridge: SandboxBridge;
  private readonly allowedMethods: Set<string>;
  private runCounter = 0;
  private activeRunId: number | null = null;

  constructor({
    bridge,
    hooks = {},
    allowedMethods = [
      "runme.clear",
      "runme.clearOutputs",
      "runme.runAll",
      "runme.rerun",
      "runme.getCurrentNotebook",
      "runme.help",
      ...SANDBOX_NOTEBOOKS_API_METHODS,
    ],
  }: {
    bridge: SandboxBridge;
    hooks?: KernelHooks;
    allowedMethods?: string[];
  }) {
    this.bridge = bridge;
    this.allowedMethods = new Set(allowedMethods);
    this.hooks = {
      onStdout: hooks.onStdout ?? (() => {}),
      onStderr: hooks.onStderr ?? (() => {}),
      onExit: hooks.onExit ?? (() => {}),
    };
  }

  async run(code: string): Promise<void> {
    const runId = ++this.runCounter;
    this.activeRunId = runId;
    let exitCode = 0;

    const stdout = (data: string) => {
      if (this.activeRunId !== runId) {
        return;
      }
      this.hooks.onStdout(data);
    };
    const stderr = (data: string) => {
      if (this.activeRunId !== runId) {
        return;
      }
      this.hooks.onStderr(data);
    };

    try {
      const session = await this.createSession();
      await new Promise<void>((resolve) => {
        session.port.onmessage = (event: MessageEvent<SandboxMessage>) => {
          const payload = event.data;
          if (!payload || typeof payload !== "object") {
            return;
          }
          switch (payload.type) {
            case "stdout":
              stdout(String(payload.data ?? ""));
              break;
            case "stderr":
              stderr(String(payload.data ?? ""));
              break;
            case "host-call":
              void this.handleHostCall(session.port, payload, runId);
              break;
            case "exit":
              exitCode = Number(payload.exitCode ?? 1);
              resolve();
              break;
            default:
              break;
          }
        };
        session.port.postMessage({ type: "run", code });
      });
      session.dispose();
    } catch (error) {
      exitCode = 1;
      appLogger.error("SandboxJSKernel execution failed", {
        attrs: {
          scope: "appkernel.sandbox",
          error: String(error),
          runId,
          codeLength: code.length,
        },
      });
      stderr(`${String(error)}\n`);
    } finally {
      if (this.activeRunId === runId) {
        this.activeRunId = null;
      }
      this.hooks.onExit(exitCode);
    }
  }

  private async handleHostCall(
    port: MessagePort,
    payload: Extract<SandboxMessage, { type: "host-call" }>,
    runId: number,
  ): Promise<void> {
    const callId = Number(payload.callId ?? 0);
    const method = String(payload.method ?? "");
    const args = Array.isArray(payload.args) ? payload.args : [];

    if (!callId) {
      return;
    }
    if (this.activeRunId !== runId) {
      port.postMessage({
        type: "host-error",
        callId,
        error: "Sandbox call ignored because the run is no longer active.",
      });
      return;
    }
    if (!this.allowedMethods.has(method)) {
      port.postMessage({
        type: "host-error",
        callId,
        error: `Sandbox method not allowed: ${method}`,
      });
      return;
    }

    try {
      const result = await this.bridge.call(method, args);
      port.postMessage({ type: "host-result", callId, result });
    } catch (error) {
      port.postMessage({
        type: "host-error",
        callId,
        error: String(error),
      });
    }
  }

  protected async createSession(): Promise<SandboxSession> {
    if (!document?.body) {
      throw new Error("SandboxJSKernel requires document.body.");
    }

    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.display = "none";
    iframe.srcdoc = SANDBOX_SRC_DOC;

    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error("Timed out waiting for sandbox iframe to load."));
      }, LOAD_TIMEOUT_MS);
      iframe.onload = () => {
        clearTimeout(timeoutId);
        resolve();
      };
      iframe.onerror = () => {
        clearTimeout(timeoutId);
        reject(new Error("Failed to load sandbox iframe."));
      };
      document.body.appendChild(iframe);
    });

    if (!iframe.contentWindow) {
      iframe.remove();
      throw new Error("Sandbox iframe content window is unavailable.");
    }

    const channel = new MessageChannel();
    const hostPort = channel.port1;
    hostPort.start();

    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error("Timed out waiting for sandbox iframe readiness."));
      }, READY_TIMEOUT_MS);

      const onReady = (event: MessageEvent<SandboxMessage>) => {
        const payload = event.data;
        if (!payload || payload.type !== "ready") {
          return;
        }
        clearTimeout(timeoutId);
        hostPort.removeEventListener("message", onReady as EventListener);
        resolve();
      };
      hostPort.addEventListener("message", onReady as EventListener);
      iframe.contentWindow.postMessage(
        { type: SANDBOX_INIT_MESSAGE },
        "*",
        [channel.port2],
      );
    });

    return {
      iframe,
      port: hostPort,
      dispose: () => {
        hostPort.onmessage = null;
        try {
          hostPort.close();
        } catch {
          // no-op
        }
        iframe.remove();
      },
    };
  }
}
