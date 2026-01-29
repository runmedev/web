import * as d3 from "d3";

type KernelHooks = {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  onExit?: (exitCode: number) => void;
};

type RunOptions = {
  /** Additional globals to inject for this run only. */
  globals?: Record<string, unknown>;
  /** Optional DOM container exposed via aisre.render. */
  container?: HTMLElement | null;
};

type RunnersApi = {
  get: () => string;
  update: (name: string, endpoint: string) => string;
  delete: (name: string) => string;
  getDefault: () => string;
  setDefault: (name: string) => string;
};

/**
 * Minimal JS runtime for executing snippets with a controlled set of globals.
 * Injects d3, aisre helpers, and a mocked console that forwards to callbacks.
 */
export class JSKernel {
  private readonly hooks: Required<KernelHooks>;
  private readonly baseGlobals: Record<string, unknown>;
  private runCounter = 0;
  private activeRunId: number | null = null;

  constructor({
    globals = {},
    hooks = {},
  }: {
    globals?: Record<string, unknown>;
    hooks?: KernelHooks;
  } = {}) {
    this.baseGlobals = {
      d3,
      ...globals,
    };
    this.hooks = {
      onStdout: hooks.onStdout ?? (() => {}),
      onStderr: hooks.onStderr ?? (() => {}),
      onExit: hooks.onExit ?? (() => {}),
    };
  }

  async run(code: string, options: RunOptions = {}): Promise<void> {
    const runId = ++this.runCounter;
    this.activeRunId = runId;

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

    const aisreRunners = (options.globals?.aisreRunners ??
      this.baseGlobals.aisreRunners) as RunnersApi | undefined;
    const aisre = this.createAisreHelpers(
      runId,
      options.container,
      stdout,
      aisreRunners,
    );

    const mergedGlobals: Record<string, unknown> = {
      ...this.baseGlobals,
      ...(options.globals ?? {}),
      console: this.createConsoleProxy(stdout, stderr),
      aisre,
      help: () =>
        stdout(
          [
            "AISRE JS console helpers:",
            "- d3: D3.js",
            "- aisre.clear(): clear the render container",
            "- aisre.render(fn): render into the container with a D3 selection",
            "- console.log/info/warn/error: write to this console",
            "- aisre.runners.get(): list configured runners",
            "- aisre.runners.update(name, endpoint): add/update a runner",
            "- aisre.runners.delete(name): remove a runner",
            "- aisre.runners.getDefault(): show default runner",
            "- aisre.runners.setDefault(name): set default runner",
            "- help(): show this message",
          ].join("\n") + "\n",
        ),
    };

    const argNames = Object.keys(mergedGlobals);
    const argValues = argNames.map((key) => mergedGlobals[key]);

    let exitCode = 0;
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const runner = new Function(
        ...argNames,
        `"use strict"; return (async () => {\n${code}\n})();`,
      );
      await runner(...argValues);
    } catch (err) {
      exitCode = 1;
      stderr(`${String(err)}\n`);
    } finally {
      if (this.activeRunId === runId) {
        this.activeRunId = null;
      }
      this.hooks.onExit(exitCode);
    }
  }

  // Proxy console that routes messages into the kernel's stdout/stderr hooks.
  private createConsoleProxy(
    stdout: (data: string) => void,
    stderr: (data: string) => void,
  ) {
    return {
      log: (...args: unknown[]) => stdout(this.formatArgs(args)),
      info: (...args: unknown[]) => stdout(this.formatArgs(args)),
      warn: (...args: unknown[]) => stderr(this.formatArgs(args)),
      error: (...args: unknown[]) => stderr(this.formatArgs(args)),
    };
  }

  private formatArgs(args: unknown[]): string {
    return (
      args
        .map((a) => {
          if (typeof a === "string") {
            return a;
          }
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" ") + "\n"
    );
  }

  private createAisreHelpers(
    runId: number,
    container: HTMLElement | null | undefined,
    stdout: (data: string) => void,
    runners?: RunnersApi,
  ) {
    return {
      clear: () => {
        if (this.activeRunId !== runId) {
          return;
        }
        if (container) {
          container.innerHTML = "";
        }
      },
      render: (
        renderFn: (
          selection: d3.Selection<HTMLElement, unknown, null, undefined>,
        ) => void | Promise<void>,
      ) => {
        if (this.activeRunId !== runId) {
          return;
        }
        if (!container) {
          return;
        }
        container.innerHTML = "";
        const selection = d3.select(container as HTMLElement);
        return renderFn(selection);
      },
      runners:
        runners &&
        (() => ({
          get: () => {
            const res = runners.get();
            stdout(res + "\n");
            return res;
          },
          update: (name: string, endpoint: string) => {
            const res = runners.update(name, endpoint);
            stdout(res + "\n");
            return res;
          },
          delete: (name: string) => {
            const res = runners.delete(name);
            stdout(res + "\n");
            return res;
          },
          getDefault: () => {
            const res = runners.getDefault();
            stdout(res + "\n");
            return res;
          },
          setDefault: (name: string) => {
            const res = runners.setDefault(name);
            stdout(res + "\n");
            return res;
          },
        }))(),
    };
  }
}
