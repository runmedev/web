import { Subject } from "rxjs";
import { create } from "@bufbuild/protobuf";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parser_pb, MimeType, RunmeMetadataKey } from "../contexts/CellContext";
import type { StreamsLike } from "@runmedev/renderers";
import {
  APPKERNEL_RUNNER_NAME,
  APPKERNEL_SANDBOX_RUNNER_NAME,
} from "./runtime/appKernel";
import { appState } from "./runtime/AppState";

const mockRunner = {
  name: "mock-runner",
  endpoint: "https://runner.example.com",
  reconnect: true,
  interceptors: [],
};

vi.mock("@runmedev/renderers", () => {
  class FakeStreams {
    stdout = new Subject<Uint8Array>();
    stderr = new Subject<Uint8Array>();
    exitCode = new Subject<number>();
    pid = new Subject<number>();
    mimeType = new Subject<string>();
    errors = new Subject<Error>();
    knownID: string;
    runID: string;
    sequence: number;
    options: unknown;
    constructor(opts: { knownID: string; runID: string; sequence: number; options: unknown }) {
      this.knownID = opts.knownID;
      this.runID = opts.runID;
      this.sequence = opts.sequence;
      this.options = opts.options;
    }
    connect() {
      return new Subject<void>();
    }
    sendExecuteRequest = vi.fn();
    setCallback = vi.fn();
    close = vi.fn();
  }

  return {
    Streams: FakeStreams,
    Heartbeat: { INITIAL: "INITIAL" },
    genRunID: () => "run-generated",
    ClientMessages: {},
    setContext: vi.fn(),
  };
});

vi.mock("./runtime/sandboxJsKernel", () => ({
  SandboxJSKernel: class {
    private readonly bridge: {
      call: (method: string, args: unknown[]) => Promise<unknown> | unknown;
    };
    private readonly hooks: {
      onStdout?: (data: string) => void;
      onStderr?: (data: string) => void;
      onExit?: (exitCode: number) => void;
    };

    constructor({
      bridge,
      hooks = {},
    }: {
      bridge: {
        call: (method: string, args: unknown[]) => Promise<unknown> | unknown;
      };
      hooks?: {
        onStdout?: (data: string) => void;
        onStderr?: (data: string) => void;
        onExit?: (exitCode: number) => void;
      };
    }) {
      this.bridge = bridge;
      this.hooks = hooks;
    }

    async run(source: string): Promise<void> {
      let exitCode = 0;
      try {
        if (source.includes("runme.getCurrentNotebook")) {
          const notebook = (await this.bridge.call(
            "runme.getCurrentNotebook",
            [],
          )) as { name?: string; cellCount?: number } | null;
          this.hooks.onStdout?.(`${notebook?.name ?? ""}\n`);
          this.hooks.onStdout?.(`${notebook?.cellCount ?? ""}\n`);
        }
        if (source.includes("runme.clear")) {
          const message = await this.bridge.call("runme.clear", [undefined]);
          this.hooks.onStdout?.(`${String(message)}\n`);
        }
        if (source.includes("notebooks.get")) {
          const doc = (await this.bridge.call("notebooks.get", [
            undefined,
          ])) as { summary?: { name?: string }; notebook?: { cells?: unknown[] } };
          this.hooks.onStdout?.(`${doc?.summary?.name ?? ""}\n`);
          this.hooks.onStdout?.(`${doc?.notebook?.cells?.length ?? 0}\n`);
        }
      } catch (error) {
        exitCode = 1;
        this.hooks.onStderr?.(`${String(error)}\n`);
      } finally {
        this.hooks.onExit?.(exitCode);
      }
    }
  },
}));

const runnerStore = new Map<string, any>();
let defaultRunnerName: string | null = null;
const getWithFallback = vi.fn((name?: string | null) => {
  if (name && runnerStore.has(name)) {
    return runnerStore.get(name);
  }
  if (defaultRunnerName && runnerStore.has(defaultRunnerName)) {
    return runnerStore.get(defaultRunnerName);
  }
  return mockRunner;
});
const runnersManager = {
  getWithFallback,
  list: vi.fn(() => [...runnerStore.values()]),
  get: vi.fn((name: string) => runnerStore.get(name)),
  update: vi.fn((name: string, endpoint: string, reconnect = true) => {
    const next = { name, endpoint, reconnect, interceptors: [] };
    runnerStore.set(name, next);
    if (!defaultRunnerName) {
      defaultRunnerName = name;
    }
    return next;
  }),
  delete: vi.fn((name: string) => {
    runnerStore.delete(name);
    if (defaultRunnerName === name) {
      defaultRunnerName = runnerStore.size > 0 ? [...runnerStore.keys()][0] : null;
    }
  }),
  getDefaultRunnerName: vi.fn(() => defaultRunnerName),
  setDefault: vi.fn((name: string) => {
    if (runnerStore.has(name)) {
      defaultRunnerName = name;
    }
  }),
};
vi.mock("./runtime/runnersManager", () => ({
  DEFAULT_RUNNER_PLACEHOLDER: "<default>",
  getRunnersManager: () => runnersManager,
}));

const harnessStore = new Map<
  string,
  {
    name: string;
    baseUrl: string;
    adapter: "responses-direct" | "codex";
  }
>();
let defaultHarnessName: string | null = null;
const harnessManager = {
  list: vi.fn(() => [...harnessStore.values()]),
  getDefaultName: vi.fn(() => defaultHarnessName ?? ""),
  getDefault: vi.fn(() => {
    if (defaultHarnessName && harnessStore.has(defaultHarnessName)) {
      return harnessStore.get(defaultHarnessName)!;
    }
    const first = harnessStore.values().next().value;
    return (
      first ?? {
        name: "local-responses",
        baseUrl: "http://localhost",
        adapter: "responses-direct",
      }
    );
  }),
  update: vi.fn(
    (
      name: string,
      baseUrl: string,
      adapter: "responses-direct" | "codex",
    ) => {
      const next = { name, baseUrl, adapter };
      harnessStore.set(name, next);
      if (!defaultHarnessName) {
        defaultHarnessName = name;
      }
      return next;
    },
  ),
  delete: vi.fn((name: string) => {
    harnessStore.delete(name);
    if (defaultHarnessName === name) {
      defaultHarnessName = harnessStore.size > 0 ? [...harnessStore.keys()][0] : null;
    }
  }),
  setDefault: vi.fn((name: string) => {
    if (harnessStore.has(name)) {
      defaultHarnessName = name;
    }
  }),
  resolveChatkitUrl: vi.fn(
    (
      profile: {
        baseUrl: string;
        adapter: "responses-direct" | "codex";
      },
    ) =>
      `${profile.baseUrl}/${
        profile.adapter === "codex"
          ? "chatkit-codex"
          : "chatkit-responses-direct"
      }`,
  ),
};
vi.mock("./runtime/harnessManager", () => ({
  getHarnessManager: () => harnessManager,
}));

const codexProjectStore = new Map<
  string,
  {
    id: string;
    name: string;
    cwd: string;
    model: string;
    approvalPolicy: string;
    sandboxPolicy: string;
    personality: string;
  }
>();
let defaultCodexProjectId: string | null = null;
const codexProjectManager = {
  list: vi.fn(() => [...codexProjectStore.values()]),
  getDefaultId: vi.fn(() => defaultCodexProjectId ?? ""),
  getDefault: vi.fn(() => {
    if (defaultCodexProjectId && codexProjectStore.has(defaultCodexProjectId)) {
      return codexProjectStore.get(defaultCodexProjectId)!;
    }
    const first = codexProjectStore.values().next().value;
    return (
      first ?? {
        id: "local-default",
        name: "Local Project",
        cwd: ".",
        model: "gpt-5",
        approvalPolicy: "never",
        sandboxPolicy: "workspace-write",
        personality: "default",
      }
    );
  }),
  create: vi.fn(
    (
      name: string,
      cwd: string,
      model: string,
      sandboxPolicy: string,
      approvalPolicy: string,
      personality: string,
    ) => {
      const id = `project-${codexProjectStore.size + 1}`;
      const next = {
        id,
        name,
        cwd,
        model,
        sandboxPolicy,
        approvalPolicy,
        personality,
      };
      codexProjectStore.set(id, next);
      if (!defaultCodexProjectId) {
        defaultCodexProjectId = id;
      }
      return next;
    },
  ),
  update: vi.fn((id: string, patch: Record<string, unknown>) => {
    const current = codexProjectStore.get(id);
    if (!current) {
      throw new Error(`Codex project ${id} not found`);
    }
    const next = { ...current, ...patch, id };
    codexProjectStore.set(id, next);
    return next;
  }),
  delete: vi.fn((id: string) => {
    codexProjectStore.delete(id);
    if (defaultCodexProjectId === id) {
      defaultCodexProjectId =
        codexProjectStore.size > 0 ? [...codexProjectStore.keys()][0] : null;
    }
  }),
  setDefault: vi.fn((id: string) => {
    if (codexProjectStore.has(id)) {
      defaultCodexProjectId = id;
    }
  }),
};
vi.mock("./runtime/codexProjectManager", () => ({
  getCodexProjectManager: () => codexProjectManager,
}));

let bindStreamsToCell: typeof import("./notebookData").bindStreamsToCell;
let NotebookData: typeof import("./notebookData").NotebookData;

type FakeStreams = StreamsLike & {
  stdout$: Subject<Uint8Array>;
  stderr$: Subject<Uint8Array>;
  exitCode$: Subject<number>;
  pid$: Subject<number>;
  mimeType$: Subject<string>;
  errors$: Subject<Error>;
};

function makeFakeStreams(): FakeStreams {
  const stdout$ = new Subject<Uint8Array>();
  const stderr$ = new Subject<Uint8Array>();
  const exitCode$ = new Subject<number>();
  const pid$ = new Subject<number>();
  const mimeType$ = new Subject<string>();
  const errors$ = new Subject<Error>();

  return {
    stdout: stdout$,
    stderr: stderr$,
    exitCode: exitCode$,
    pid: pid$,
    mimeType: mimeType$,
    errors: errors$,
    stdout$,
    stderr$,
    exitCode$,
    pid$,
    mimeType$,
    errors$,
    connect: () => stdout$, // not used in tests
    sendExecuteRequest: () => {},
    setCallback: () => {},
    close: () => {
      stdout$.complete();
      stderr$.complete();
      exitCode$.complete();
      pid$.complete();
      mimeType$.complete();
      errors$.complete();
    },
  } as unknown as FakeStreams;
}

beforeAll(async () => {
  ({ bindStreamsToCell, NotebookData } = await import("./notebookData"));
});

afterEach(() => {
  appState.setDriveNotebookStore(null);
  appState.setLocalNotebooks(null);
  appState.setOpenNotebookHandler(null);
  window.localStorage.removeItem("runme/responses-direct-config");
  runnerStore.clear();
  defaultRunnerName = null;
  harnessStore.clear();
  defaultHarnessName = null;
  codexProjectStore.clear();
  defaultCodexProjectId = null;
});

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 200,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("bindStreamsToCell", () => {
  it("appends stdout/stderr to existing outputs", () => {
    const refId = "cell-1";
    const cell = create(parser_pb.CellSchema, {
      refId,
      kind: parser_pb.CellKind.CODE,
      outputs: [],
      metadata: {},
    });

    let current = cell;
    const getCell = () => current;
    const updateCell = (next: typeof cell) => {
      current = next;
    };

    const fake = makeFakeStreams();
    bindStreamsToCell({ refId, streams: fake, getCell, updateCell });

    fake.stdout$.next(new TextEncoder().encode("hello"));
    fake.stdout$.next(new TextEncoder().encode(" world"));
    fake.stderr$.next(new TextEncoder().encode("oops"));
    fake.stderr$.next(new TextEncoder().encode(" again"));
    // Stdout chunks without a newline are flushed when the run exits.
    fake.exitCode$.next(0);

    const stdoutItem = current.outputs
      .flatMap((o) => o.items)
      .find((i) => i.mime === MimeType.VSCodeNotebookStdOut);
    const stderrItem = current.outputs
      .flatMap((o) => o.items)
      .find((i) => i.mime === MimeType.VSCodeNotebookStdErr);

    expect(stdoutItem).toBeTruthy();
    expect(new TextDecoder().decode(stdoutItem!.data)).toBe("hello world");
    expect(stderrItem).toBeTruthy();
    expect(new TextDecoder().decode(stderrItem!.data)).toBe("oops again");
  });

  it("updates pid and clears it when exit code arrives", () => {
    const refId = "cell-2";
    const cell = create(parser_pb.CellSchema, {
      refId,
      kind: parser_pb.CellKind.CODE,
      outputs: [],
      metadata: {},
    });

    let current = cell;
    const getCell = () => current;
    const updateCell = (next: typeof cell) => {
      current = next;
    };

    const fake = makeFakeStreams();
    bindStreamsToCell({ refId, streams: fake, getCell, updateCell });

    fake.pid$.next(123);
    expect(current.metadata?.[RunmeMetadataKey.Pid]).toBe("123");
    fake.exitCode$.next(0);

    expect(current.metadata?.[RunmeMetadataKey.Pid]).toBeUndefined();
    expect(current.metadata?.[RunmeMetadataKey.ExitCode]).toBe("0");
  });
});

describe("NotebookData.getActiveStream", () => {
  it("recovers stream when metadata indicates an active run", () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-recover",
      kind: parser_pb.CellKind.CODE,
      outputs: [],
      metadata: {
        [RunmeMetadataKey.Pid]: "1234",
        [RunmeMetadataKey.LastRunID]: "existing-run",
        [RunmeMetadataKey.Sequence]: "7",
      },
    });
    const notebook = create(parser_pb.NotebookSchema, { cells: [cell] });
    const model = new NotebookData({
      notebook,
      uri: "nb://test",
      name: "test",
      notebookStore: null,
      loaded: true,
    });

    const stream = model.getActiveStream(cell.refId) as any;
    expect(stream).toBeTruthy();
    expect(stream.runID).toBe("existing-run");
    expect(stream.sequence).toBe(7);
  });

  it("does not recover when exit code metadata is present", () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-exit",
      kind: parser_pb.CellKind.CODE,
      outputs: [],
      metadata: {
        [RunmeMetadataKey.Pid]: "1234",
        [RunmeMetadataKey.LastRunID]: "finished-run",
        [RunmeMetadataKey.ExitCode]: "0",
      },
    });
    const notebook = create(parser_pb.NotebookSchema, { cells: [cell] });
    const model = new NotebookData({
      notebook,
      uri: "nb://test",
      name: "test",
      notebookStore: null,
      loaded: true,
    });

    expect(model.getActiveStream(cell.refId)).toBeUndefined();
  });
});

describe("NotebookData cell defaults", () => {
  it("creates markdown cells by default for new notebooks", () => {
    const notebook = create(parser_pb.NotebookSchema, { cells: [] });
    const model = new NotebookData({
      notebook,
      uri: "nb://new",
      name: "new",
      notebookStore: null,
      loaded: true,
    });

    const cell = model.appendCodeCell();

    expect(cell.languageId).toBe("markdown");
    expect(cell.kind).toBe(parser_pb.CellKind.CODE);
  });
});

describe("NotebookData.runCodeCell", () => {
  it("returns empty run id when no runner is available", () => {
    getWithFallback.mockReturnValueOnce(undefined);

    const cell = create(parser_pb.CellSchema, {
      refId: "cell-no-runner",
      kind: parser_pb.CellKind.CODE,
      outputs: [],
      metadata: {},
      value: "echo hello",
    });
    const notebook = create(parser_pb.NotebookSchema, { cells: [cell] });
    const model = new NotebookData({
      notebook,
      uri: "nb://test",
      name: "test",
      notebookStore: null,
      loaded: true,
    });

    const runID = model.runCodeCell(cell);
    expect(runID).toBe("");
  });

  it("executes javascript locally with appkernel and records stdout + exit code", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-appkernel",
      kind: parser_pb.CellKind.CODE,
      languageId: "javascript",
      outputs: [],
      metadata: {
        [RunmeMetadataKey.RunnerName]: APPKERNEL_RUNNER_NAME,
      },
      value: 'console.log("hello");',
    });
    const notebook = create(parser_pb.NotebookSchema, { cells: [cell] });
    const model = new NotebookData({
      notebook,
      uri: "nb://test",
      name: "test-notebook.runme.md",
      notebookStore: null,
      loaded: true,
    });

    const runID = model.runCodeCell(cell);
    expect(runID).toBe("run-generated");

    await waitForCondition(() => {
      const snap = model.getCellSnapshot(cell.refId);
      return snap?.metadata?.[RunmeMetadataKey.ExitCode] === "0";
    });

    const updated = model.getCellSnapshot(cell.refId);
    expect(updated?.metadata?.[RunmeMetadataKey.ExitCode]).toBe("0");
    expect(updated?.metadata?.[RunmeMetadataKey.Pid]).toBeUndefined();

    const stdoutItem = updated?.outputs
      .flatMap((o) => o.items)
      .find((i) => i.mime === MimeType.VSCodeNotebookStdOut);
    expect(stdoutItem).toBeTruthy();
    expect(new TextDecoder().decode(stdoutItem!.data)).toContain("hello");
  });

  it("executes javascript with AppKernel even when runner metadata is not set", async () => {
    getWithFallback.mockReturnValueOnce(undefined);
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-appkernel-no-runner",
      kind: parser_pb.CellKind.CODE,
      languageId: "javascript",
      outputs: [],
      metadata: {},
      value: 'console.log("hello-no-runner");',
    });
    const notebook = create(parser_pb.NotebookSchema, { cells: [cell] });
    const model = new NotebookData({
      notebook,
      uri: "nb://test",
      name: "test-notebook.runme.md",
      notebookStore: null,
      loaded: true,
    });

    const runID = model.runCodeCell(cell);
    expect(runID).toBe("run-generated");

    await waitForCondition(() => {
      const snap = model.getCellSnapshot(cell.refId);
      return snap?.metadata?.[RunmeMetadataKey.ExitCode] === "0";
    });

    const updated = model.getCellSnapshot(cell.refId);
    const stdoutItem = updated?.outputs
      .flatMap((o) => o.items)
      .find((i) => i.mime === MimeType.VSCodeNotebookStdOut);
    expect(stdoutItem).toBeTruthy();
    expect(new TextDecoder().decode(stdoutItem!.data)).toContain("hello-no-runner");
  });

  it("supports runme helper access inside appkernel javascript cells", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-appkernel-helper",
      kind: parser_pb.CellKind.CODE,
      languageId: "javascript",
      outputs: [],
      metadata: {
        [RunmeMetadataKey.RunnerName]: APPKERNEL_RUNNER_NAME,
      },
      value: 'const nb = runme.getCurrentNotebook(); console.log(Boolean(nb)); console.log(nb?.getName?.() ?? "");',
    });
    const notebook = create(parser_pb.NotebookSchema, { cells: [cell] });
    const model = new NotebookData({
      notebook,
      uri: "nb://test",
      name: "helper-notebook.runme.md",
      notebookStore: null,
      loaded: true,
    });

    model.runCodeCell(cell);
    await waitForCondition(() => {
      const snap = model.getCellSnapshot(cell.refId);
      const stdoutText = (snap?.outputs ?? [])
        .flatMap((o) => o.items)
        .filter((i) => i.mime === MimeType.VSCodeNotebookStdOut)
        .map((i) => new TextDecoder().decode(i.data))
        .join("");
      return stdoutText.includes("true");
    });

    const updated = model.getCellSnapshot(cell.refId);
    const stdoutText = (updated?.outputs ?? [])
      .flatMap((o) => o.items)
      .filter((i) => i.mime === MimeType.VSCodeNotebookStdOut)
      .map((i) => new TextDecoder().decode(i.data))
      .join("");
    expect(stdoutText).toContain("true");
    expect(stdoutText).toContain("helper-notebook.runme.md");
  });

  it("exposes notebooks.get helper inside browser appkernel javascript cells", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-appkernel-notebooks-get-browser",
      kind: parser_pb.CellKind.CODE,
      languageId: "javascript",
      outputs: [],
      metadata: {
        [RunmeMetadataKey.RunnerName]: APPKERNEL_RUNNER_NAME,
      },
      value: [
        "const doc = await notebooks.get();",
        "console.log(doc.summary.name);",
        "console.log(doc.notebook.cells.length);",
      ].join("\n"),
    });
    const notebook = create(parser_pb.NotebookSchema, { cells: [cell] });
    const model = new NotebookData({
      notebook,
      uri: "nb://test",
      name: "browser-notebooks-get.runme.md",
      notebookStore: null,
      loaded: true,
    });

    model.runCodeCell(cell);
    await waitForCondition(() => {
      const snap = model.getCellSnapshot(cell.refId);
      return snap?.metadata?.[RunmeMetadataKey.ExitCode] === "0";
    });

    const updated = model.getCellSnapshot(cell.refId);
    const stdoutText = (updated?.outputs ?? [])
      .flatMap((o) => o.items)
      .filter((i) => i.mime === MimeType.VSCodeNotebookStdOut)
      .map((i) => new TextDecoder().decode(i.data))
      .join("");
    expect(stdoutText).toContain("browser-notebooks-get.runme.md");
    expect(stdoutText).toContain("1");
  });

  it("exposes notebooks.get helper inside sandbox appkernel javascript cells", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-appkernel-notebooks-get-sandbox",
      kind: parser_pb.CellKind.CODE,
      languageId: "javascript",
      outputs: [],
      metadata: {
        [RunmeMetadataKey.RunnerName]: APPKERNEL_SANDBOX_RUNNER_NAME,
      },
      value: [
        "const doc = await notebooks.get();",
        "console.log(doc.summary.name);",
        "console.log(doc.notebook.cells.length);",
      ].join("\n"),
    });
    const notebook = create(parser_pb.NotebookSchema, { cells: [cell] });
    const model = new NotebookData({
      notebook,
      uri: "nb://test",
      name: "sandbox-notebooks-get.runme.md",
      notebookStore: null,
      loaded: true,
    });

    model.runCodeCell(cell);
    await waitForCondition(() => {
      const snap = model.getCellSnapshot(cell.refId);
      return snap?.metadata?.[RunmeMetadataKey.ExitCode] === "0";
    });

    const updated = model.getCellSnapshot(cell.refId);
    const stdoutText = (updated?.outputs ?? [])
      .flatMap((o) => o.items)
      .filter((i) => i.mime === MimeType.VSCodeNotebookStdOut)
      .map((i) => new TextDecoder().decode(i.data))
      .join("");
    expect(stdoutText).toContain("sandbox-notebooks-get.runme.md");
    expect(stdoutText).toContain("1");
  });

  it("exposes notebooks.list across open notebooks inside browser appkernel javascript cells", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-appkernel-notebooks-list-browser",
      kind: parser_pb.CellKind.CODE,
      languageId: "javascript",
      outputs: [],
      metadata: {
        [RunmeMetadataKey.RunnerName]: APPKERNEL_RUNNER_NAME,
      },
      value: [
        "const list = await notebooks.list();",
        "console.log(JSON.stringify(list.map((item) => item.name).sort()));",
        "console.log(list.length);",
      ].join("\n"),
    });
    const primaryNotebook = create(parser_pb.NotebookSchema, { cells: [cell] });
    const secondaryNotebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          refId: "cell-secondary",
          kind: parser_pb.CellKind.CODE,
          languageId: "javascript",
          outputs: [],
          metadata: {},
          value: "console.log('secondary')",
        }),
      ],
    });

    const byUri = new Map<string, InstanceType<typeof NotebookData>>();
    let primaryModel: InstanceType<typeof NotebookData> | null = null;
    const resolveTargetUri = (target?: unknown): string | null => {
      if (typeof target === "string" && target.trim() !== "") {
        return target.trim();
      }
      if (
        typeof target === "object" &&
        target &&
        "uri" in target &&
        typeof (target as { uri?: unknown }).uri === "string" &&
        (target as { uri: string }).uri.trim() !== ""
      ) {
        return (target as { uri: string }).uri.trim();
      }
      if (
        typeof target === "object" &&
        target &&
        "handle" in target &&
        typeof (target as { handle?: { uri?: unknown } }).handle?.uri ===
          "string" &&
        (
          target as { handle: { uri: string } }
        ).handle.uri.trim() !== ""
      ) {
        return (target as { handle: { uri: string } }).handle.uri.trim();
      }
      return null;
    };
    const resolveNotebook = (target?: unknown) => {
      const targetUri = resolveTargetUri(target);
      if (!targetUri) {
        return primaryModel;
      }
      return byUri.get(targetUri) ?? null;
    };
    const listNotebooks = () => Array.from(byUri.values());

    primaryModel = new NotebookData({
      notebook: primaryNotebook,
      uri: "nb://primary",
      name: "primary-notebooks-list.runme.md",
      notebookStore: null,
      loaded: true,
      resolveNotebookForAppKernel: resolveNotebook,
      listNotebooksForAppKernel: listNotebooks,
    });
    const secondaryModel = new NotebookData({
      notebook: secondaryNotebook,
      uri: "nb://secondary",
      name: "secondary-notebooks-list.runme.md",
      notebookStore: null,
      loaded: true,
      resolveNotebookForAppKernel: resolveNotebook,
      listNotebooksForAppKernel: listNotebooks,
    });
    byUri.set(primaryModel.getUri(), primaryModel);
    byUri.set(secondaryModel.getUri(), secondaryModel);

    primaryModel.runCodeCell(cell);
    await waitForCondition(() => {
      const snap = primaryModel?.getCellSnapshot(cell.refId);
      return snap?.metadata?.[RunmeMetadataKey.ExitCode] === "0";
    });

    const updated = primaryModel.getCellSnapshot(cell.refId);
    const stdoutText = (updated?.outputs ?? [])
      .flatMap((o) => o.items)
      .filter((i) => i.mime === MimeType.VSCodeNotebookStdOut)
      .map((i) => new TextDecoder().decode(i.data))
      .join("");
    expect(stdoutText).toContain("primary-notebooks-list.runme.md");
    expect(stdoutText).toContain("secondary-notebooks-list.runme.md");
    expect(stdoutText).toContain("2");
  });

  it("exposes drive and google helper namespaces in appkernel cells", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-appkernel-drive-helpers",
      kind: parser_pb.CellKind.CODE,
      languageId: "javascript",
      outputs: [],
      metadata: {
        [RunmeMetadataKey.RunnerName]: APPKERNEL_RUNNER_NAME,
      },
      value: [
        'console.log(typeof drive);',
        'console.log(typeof drive.create);',
        'console.log(typeof drive.saveAsCurrentNotebook);',
        'console.log(typeof drive.listPendingSync);',
        'console.log(typeof drive.requeuePendingSync);',
        'console.log(typeof googleClientManager.get);',
        'console.log(typeof oidc.getStatus);',
        'console.log(typeof app.getDefaultConfigUrl);',
        'console.log(typeof app.openNotebook);',
        'console.log(typeof app.setConfigFromYaml);',
      ].join("\n"),
    });
    const notebook = create(parser_pb.NotebookSchema, { cells: [cell] });
    const model = new NotebookData({
      notebook,
      uri: "nb://test",
      name: "drive-helpers.runme.md",
      notebookStore: null,
      loaded: true,
    });

    model.runCodeCell(cell);
    await waitForCondition(() => {
      const snap = model.getCellSnapshot(cell.refId);
      return snap?.metadata?.[RunmeMetadataKey.ExitCode] === "0";
    });

    const updated = model.getCellSnapshot(cell.refId);
    const stdoutText = (updated?.outputs ?? [])
      .flatMap((o) => o.items)
      .filter((i) => i.mime === MimeType.VSCodeNotebookStdOut)
      .map((i) => new TextDecoder().decode(i.data))
      .join("");
    expect(stdoutText).toContain("object");
    expect(stdoutText).toContain("function");
  });

  it("exposes app.runners and app.harness helpers in appkernel cells", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-appkernel-runner-harness-helpers",
      kind: parser_pb.CellKind.CODE,
      languageId: "javascript",
      outputs: [],
      metadata: {
        [RunmeMetadataKey.RunnerName]: APPKERNEL_RUNNER_NAME,
      },
      value: [
        'console.log(app.runners.update("local", "ws://localhost:5190/ws"));',
        'console.log(app.runners.setDefault("local"));',
        'console.log(app.runners.getDefault());',
        'console.log(app.harness.update("local-codex", "http://localhost:5190", "codex"));',
        'console.log(app.harness.setDefault("local-codex"));',
        'console.log(app.harness.getDefault());',
      ].join("\n"),
    });
    const notebook = create(parser_pb.NotebookSchema, { cells: [cell] });
    const model = new NotebookData({
      notebook,
      uri: "nb://test",
      name: "runner-harness-helpers.runme.md",
      notebookStore: null,
      loaded: true,
    });

    model.runCodeCell(cell);
    await waitForCondition(() => {
      const snap = model.getCellSnapshot(cell.refId);
      return snap?.metadata?.[RunmeMetadataKey.ExitCode] === "0";
    });

    const updated = model.getCellSnapshot(cell.refId);
    const stdoutText = (updated?.outputs ?? [])
      .flatMap((o) => o.items)
      .filter((i) => i.mime === MimeType.VSCodeNotebookStdOut)
      .map((i) => new TextDecoder().decode(i.data))
      .join("");
    expect(stdoutText).toContain("Runner local set to ws://localhost:5190/ws");
    expect(stdoutText).toContain("Default runner set to local");
    expect(stdoutText).toContain("Default runner: local (ws://localhost:5190/ws)");
    expect(stdoutText).toContain(
      "Harness local-codex set to http://localhost:5190 (codex)",
    );
    expect(stdoutText).toContain("Default harness set to local-codex");
    expect(stdoutText).toContain(
      "Default harness: local-codex (http://localhost:5190, codex)",
    );
  });

  it("exposes app.codex.project helpers in appkernel cells", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-appkernel-codex-project-helpers",
      kind: parser_pb.CellKind.CODE,
      languageId: "javascript",
      outputs: [],
      metadata: {
        [RunmeMetadataKey.RunnerName]: APPKERNEL_RUNNER_NAME,
      },
      value: [
        'const created = app.codex.project.create("Runme Repo", "/Users/jlewi/code/runmecodex/web", "gpt-5", "workspace-write", "never", "default");',
        "console.log(created);",
        'console.log(app.codex.project.update("project-1", { model: "gpt-5-mini" }));',
        'console.log(app.codex.project.setDefault("project-1"));',
        "console.log(app.codex.project.getDefault());",
        "console.log(app.codex.project.list());",
      ].join("\n"),
    });
    const notebook = create(parser_pb.NotebookSchema, { cells: [cell] });
    const model = new NotebookData({
      notebook,
      uri: "nb://test",
      name: "codex-project-helpers.runme.md",
      notebookStore: null,
      loaded: true,
    });

    model.runCodeCell(cell);
    await waitForCondition(() => {
      const snap = model.getCellSnapshot(cell.refId);
      return snap?.metadata?.[RunmeMetadataKey.ExitCode] === "0";
    });

    const updated = model.getCellSnapshot(cell.refId);
    const stdoutText = (updated?.outputs ?? [])
      .flatMap((o) => o.items)
      .filter((i) => i.mime === MimeType.VSCodeNotebookStdOut)
      .map((i) => new TextDecoder().decode(i.data))
      .join("");
    expect(stdoutText).toContain("Codex project Runme Repo created (project-1)");
    expect(stdoutText).toContain("Codex project Runme Repo updated (project-1)");
    expect(stdoutText).toContain("Default codex project set to project-1");
    expect(stdoutText).toContain(
      "Default codex project: Runme Repo (project-1, cwd=/Users/jlewi/code/runmecodex/web, model=gpt-5-mini)",
    );
    expect(stdoutText).toContain(
      "project-1: Runme Repo (/Users/jlewi/code/runmecodex/web, model=gpt-5-mini, sandbox=workspace-write, approval=never) (default)",
    );
  });

  it("exposes app.responsesDirect and credentials.openai helpers in appkernel cells", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-appkernel-responses-direct-helpers",
      kind: parser_pb.CellKind.CODE,
      languageId: "javascript",
      outputs: [],
      metadata: {
        [RunmeMetadataKey.RunnerName]: APPKERNEL_RUNNER_NAME,
      },
      value: [
        "console.log(typeof app.responsesDirect);",
        'console.log(app.responsesDirect.setAuthMethod("APIKey").authMethod);',
        'console.log(app.responsesDirect.setAPIKey("sk-test").apiKey ? "key-set" : "key-missing");',
        "console.log(app.responsesDirect.get().authMethod);",
        "console.log(typeof credentials.openai.setOpenAIProject);",
      ].join("\n"),
    });
    const notebook = create(parser_pb.NotebookSchema, { cells: [cell] });
    const model = new NotebookData({
      notebook,
      uri: "nb://test",
      name: "responses-direct-helpers.runme.md",
      notebookStore: null,
      loaded: true,
    });

    model.runCodeCell(cell);
    await waitForCondition(() => {
      const snap = model.getCellSnapshot(cell.refId);
      return snap?.metadata?.[RunmeMetadataKey.ExitCode] === "0";
    });

    const updated = model.getCellSnapshot(cell.refId);
    const stdoutText = (updated?.outputs ?? [])
      .flatMap((o) => o.items)
      .filter((i) => i.mime === MimeType.VSCodeNotebookStdOut)
      .map((i) => new TextDecoder().decode(i.data))
      .join("");
    expect(stdoutText).toContain("object");
    expect(stdoutText).toContain("api_key");
    expect(stdoutText).toContain("key-set");
    expect(stdoutText).toContain("function");
  });

  it("supports drive.saveAsCurrentNotebook in appkernel cells", async () => {
    const createRemote = vi.fn().mockResolvedValue({
      uri: "https://drive.google.com/file/d/saveas123/view",
    });
    const saveContent = vi.fn().mockResolvedValue(undefined);
    appState.setDriveNotebookStore({ create: createRemote, saveContent } as any);
    const addFile = vi.fn().mockResolvedValue("local://file/saveas-copy");
    const saveLocal = vi.fn().mockResolvedValue(undefined);
    appState.setLocalNotebooks({ addFile, save: saveLocal } as any);
    const openNotebook = vi.fn().mockResolvedValue(undefined);
    appState.setOpenNotebookHandler(openNotebook);

    const cell = create(parser_pb.CellSchema, {
      refId: "cell-appkernel-saveas",
      kind: parser_pb.CellKind.CODE,
      languageId: "javascript",
      outputs: [],
      metadata: {
        [RunmeMetadataKey.RunnerName]: APPKERNEL_RUNNER_NAME,
      },
      value: [
        'const result = await drive.saveAsCurrentNotebook("folder123", "copy.json");',
        'console.log(result.fileId);',
        'console.log(result.localUri);',
      ].join("\n"),
    });
    const notebook = create(parser_pb.NotebookSchema, { cells: [cell] });
    const model = new NotebookData({
      notebook,
      uri: "local://file/original",
      name: "saveas-source.json",
      notebookStore: null,
      loaded: true,
    });

    model.runCodeCell(cell);
    await waitForCondition(() => {
      const snap = model.getCellSnapshot(cell.refId);
      return snap?.metadata?.[RunmeMetadataKey.ExitCode] === "0";
    });

    expect(addFile).toHaveBeenCalledWith(
      "https://drive.google.com/file/d/saveas123/view",
      "copy.json",
    );
    expect(saveLocal).toHaveBeenCalled();
    expect(openNotebook).toHaveBeenCalledWith("local://file/saveas-copy");

    const updated = model.getCellSnapshot(cell.refId);
    const stdoutText = (updated?.outputs ?? [])
      .flatMap((o) => o.items)
      .filter((i) => i.mime === MimeType.VSCodeNotebookStdOut)
      .map((i) => new TextDecoder().decode(i.data))
      .join("");
    expect(stdoutText).toContain("saveas123");
    expect(stdoutText).toContain("local://file/saveas-copy");
  });

  it("supports drive.listPendingSync and drive.requeuePendingSync in appkernel cells", async () => {
    const listPendingSync = vi
      .fn()
      .mockResolvedValue(["local://file/a", "local://file/b"]);
    const requeuePendingSync = vi
      .fn()
      .mockResolvedValue(["local://file/a", "local://file/b"]);
    appState.setLocalNotebooks({
      listDriveBackedFilesNeedingSync: listPendingSync,
      enqueueDriveBackedFilesNeedingSync: requeuePendingSync,
    } as any);

    const cell = create(parser_pb.CellSchema, {
      refId: "cell-appkernel-drive-sync-helpers",
      kind: parser_pb.CellKind.CODE,
      languageId: "javascript",
      outputs: [],
      metadata: {
        [RunmeMetadataKey.RunnerName]: APPKERNEL_RUNNER_NAME,
      },
      value: [
        "const pending = await drive.listPendingSync();",
        "console.log(pending.join(','));",
        "const requeued = await drive.requeuePendingSync();",
        "console.log(requeued.join(','));",
      ].join("\n"),
    });
    const notebook = create(parser_pb.NotebookSchema, { cells: [cell] });
    const model = new NotebookData({
      notebook,
      uri: "nb://test",
      name: "drive-sync-helpers.runme.md",
      notebookStore: null,
      loaded: true,
    });

    model.runCodeCell(cell);
    await waitForCondition(() => {
      const snap = model.getCellSnapshot(cell.refId);
      return snap?.metadata?.[RunmeMetadataKey.ExitCode] === "0";
    });

    expect(listPendingSync).toHaveBeenCalledTimes(1);
    expect(requeuePendingSync).toHaveBeenCalledTimes(1);

    const updated = model.getCellSnapshot(cell.refId);
    const stdoutText = (updated?.outputs ?? [])
      .flatMap((o) => o.items)
      .filter((i) => i.mime === MimeType.VSCodeNotebookStdOut)
      .map((i) => new TextDecoder().decode(i.data))
      .join("");
    expect(stdoutText).toContain("local://file/a,local://file/b");
  });

  it("drops stale terminal output when rerunning a cell with appkernel", async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: "cell-appkernel-stale-terminal",
      kind: parser_pb.CellKind.CODE,
      languageId: "javascript",
      metadata: {
        [RunmeMetadataKey.RunnerName]: APPKERNEL_RUNNER_NAME,
      },
      value: 'console.log("fresh appkernel output");',
      outputs: [
        create(parser_pb.CellOutputSchema, {
          items: [
            create(parser_pb.CellOutputItemSchema, {
              mime: MimeType.StatefulRunmeTerminal,
              type: "Buffer",
              data: new Uint8Array(),
            }),
          ],
        }),
      ],
    });
    const notebook = create(parser_pb.NotebookSchema, { cells: [cell] });
    const model = new NotebookData({
      notebook,
      uri: "nb://test",
      name: "stale-terminal.runme.md",
      notebookStore: null,
      loaded: true,
    });

    model.runCodeCell(cell);
    await waitForCondition(() => {
      const snap = model.getCellSnapshot(cell.refId);
      return snap?.metadata?.[RunmeMetadataKey.ExitCode] === "0";
    });

    const updated = model.getCellSnapshot(cell.refId);
    const mimes = (updated?.outputs ?? []).flatMap((o) => o.items.map((i) => i.mime));
    expect(mimes).not.toContain(MimeType.StatefulRunmeTerminal);
    expect(mimes).toContain(MimeType.VSCodeNotebookStdOut);
  });
});
