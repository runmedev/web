import { describe, expect, it, vi } from "vitest";

import { JSKernel } from "./jsKernel";

function collectStdout(): {
  output: string[];
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
} {
  const output: string[] = [];
  return {
    output,
    onStdout: (data: string) => output.push(data),
    onStderr: (data: string) => output.push(data),
  };
}

describe("JSKernel", () => {
  it("merges injected app helpers with built-in app helpers", async () => {
    const stdout = vi.fn();
    const kernel = new JSKernel({
      globals: {
        app: {
          ping: () => "pong",
        },
      },
      hooks: {
        onStdout: stdout,
      },
    });

    await kernel.run('console.log(app.ping()); console.log(typeof app.clear);');

    expect(stdout).toHaveBeenCalledWith("pong\n");
    expect(stdout).toHaveBeenCalledWith("function\n");
  });

  it("merges per-run app helpers with constructor app helpers", async () => {
    const stdout = vi.fn();
    const kernel = new JSKernel({
      globals: {
        app: {
          baseOnly: () => "base",
        },
      },
      hooks: {
        onStdout: stdout,
      },
    });

    await kernel.run(
      'console.log(app.baseOnly()); console.log(app.runOnly()); console.log(typeof app.render);',
      {
        globals: {
          app: {
            runOnly: () => "run",
          },
        },
      },
    );

    expect(stdout).toHaveBeenCalledWith("base\n");
    expect(stdout).toHaveBeenCalledWith("run\n");
    expect(stdout).toHaveBeenCalledWith("function\n");
  });

  it("formats objects containing BigInt values for console output", async () => {
    const stdout = vi.fn();
    const kernel = new JSKernel({
      hooks: {
        onStdout: stdout,
      },
    });

    await kernel.run('console.log({ count: 1n, nested: { id: 2n } });');

    expect(stdout).toHaveBeenCalledWith('{"count":"1","nested":{"id":"2"}}\n');
  });
});

describe("JSKernel app globals", () => {
  it("preserves custom app namespaces like app.harness", async () => {
    const streams = collectStdout();
    const kernel = new JSKernel({
      globals: {
        app: {
          harness: {
            getDefault: () => "default-harness",
          },
        },
      },
      hooks: streams,
    });

    await kernel.run("console.log(app.harness.getDefault())");

    expect(streams.output.join("")).toContain("default-harness");
  });

  it("keeps app.runners helpers while preserving app.harness", async () => {
    const streams = collectStdout();
    const kernel = new JSKernel({
      globals: {
        app: {
          harness: {
            getDefault: () => "default-harness",
          },
        },
        runmeRunners: {
          get: () => "runner-list",
          update: () => "updated",
          delete: () => "deleted",
          getDefault: () => "default-runner",
          setDefault: () => "set-default",
        },
      },
      hooks: streams,
    });

    await kernel.run(`
      app.runners.get();
      console.log(app.harness.getDefault());
    `);

    const output = streams.output.join("");
    expect(output).toContain("runner-list");
    expect(output).toContain("default-harness");
  });

  it("retains existing app.runners when runmeRunners is not provided", async () => {
    const streams = collectStdout();
    const kernel = new JSKernel({
      globals: {
        app: {
          runners: {
            get: () => "custom-runner-get",
          },
        },
      },
      hooks: streams,
    });

    await kernel.run("console.log(app.runners.get())");

    expect(streams.output.join("")).toContain("custom-runner-get");
  });
});
