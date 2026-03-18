// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

type Kernel = {
  id: string;
  name: string;
  execution_state?: string;
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("jupyterManager aliases", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("persists kernel aliases and restores labels after manager reload", async () => {
    const kernels: Kernel[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/v1/jupyter/servers")) {
        return jsonResponse([
          { name: "port-8888", runner: "dev", base_url: "http://127.0.0.1:8888", has_token: true },
        ]);
      }
      if (url.endsWith("/v1/jupyter/servers/port-8888/kernels") && method === "GET") {
        return jsonResponse(kernels);
      }
      if (url.endsWith("/v1/jupyter/servers/port-8888/kernels") && method === "POST") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const created = {
          id: "kernel-1",
          name: typeof body.name === "string" ? body.name : "python3",
          execution_state: "starting",
        };
        kernels.push(created);
        return jsonResponse(created);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    vi.doMock("./runnersManager", () => ({
      DEFAULT_RUNNER_PLACEHOLDER: "<default>",
      getRunnersManager: () => ({
        getDefaultRunnerName: () => "dev",
        getWithFallback: () => ({ name: "dev", endpoint: "http://127.0.0.1:5191" }),
      }),
    }));
    vi.doMock("../../token", () => ({
      getAuthData: vi.fn(async () => null),
    }));
    vi.doMock("../../browserAdapter.client", () => ({
      getBrowserAdapter: () => ({ simpleAuth: {} }),
    }));

    const firstModule = await import("./jupyterManager");
    const firstManager = firstModule.getJupyterManager();
    await firstManager.startKernel("dev", "port-8888", {
      kernelSpec: "python3",
      name: "py3-local-1",
    });
    const persistedRaw = window.localStorage.getItem("runme/jupyterKernelAliases");
    expect(persistedRaw).toContain("py3-local-1");

    vi.resetModules();
    vi.doMock("./runnersManager", () => ({
      DEFAULT_RUNNER_PLACEHOLDER: "<default>",
      getRunnersManager: () => ({
        getDefaultRunnerName: () => "dev",
        getWithFallback: () => ({ name: "dev", endpoint: "http://127.0.0.1:5191" }),
      }),
    }));
    vi.doMock("../../token", () => ({
      getAuthData: vi.fn(async () => null),
    }));
    vi.doMock("../../browserAdapter.client", () => ({
      getBrowserAdapter: () => ({ simpleAuth: {} }),
    }));

    const secondModule = await import("./jupyterManager");
    const secondManager = secondModule.getJupyterManager();
    await secondManager.listKernels("dev", "port-8888");
    const options = secondManager.getKernelOptionsForRunner("dev");
    expect(options).toHaveLength(1);
    expect(options[0].label).toBe("py3-local-1");
  });

  it("rejects duplicate aliases on kernel start", async () => {
    const kernels: Kernel[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/v1/jupyter/servers")) {
        return jsonResponse([
          { name: "port-8888", runner: "dev", base_url: "http://127.0.0.1:8888", has_token: true },
        ]);
      }
      if (url.endsWith("/v1/jupyter/servers/port-8888/kernels") && method === "GET") {
        return jsonResponse(kernels);
      }
      if (url.endsWith("/v1/jupyter/servers/port-8888/kernels") && method === "POST") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const created = {
          id: `kernel-${kernels.length + 1}`,
          name: typeof body.name === "string" ? body.name : "python3",
          execution_state: "starting",
        };
        kernels.push(created);
        return jsonResponse(created);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    vi.doMock("./runnersManager", () => ({
      DEFAULT_RUNNER_PLACEHOLDER: "<default>",
      getRunnersManager: () => ({
        getDefaultRunnerName: () => "dev",
        getWithFallback: () => ({ name: "dev", endpoint: "http://127.0.0.1:5191" }),
      }),
    }));
    vi.doMock("../../token", () => ({
      getAuthData: vi.fn(async () => null),
    }));
    vi.doMock("../../browserAdapter.client", () => ({
      getBrowserAdapter: () => ({ simpleAuth: {} }),
    }));

    const { getJupyterManager } = await import("./jupyterManager");
    const manager = getJupyterManager();

    await manager.startKernel("dev", "port-8888", {
      kernelSpec: "python3",
      name: "openai2",
    });

    await expect(
      manager.startKernel("dev", "port-8888", {
        kernelSpec: "python3",
        name: "openai2",
      }),
    ).rejects.toThrow('Kernel alias "openai2" already exists');
  });
});
