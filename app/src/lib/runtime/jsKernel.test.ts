import { describe, expect, it, vi } from "vitest";

import { JSKernel } from "./jsKernel";

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
});
