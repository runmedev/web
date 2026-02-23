import { Subject } from "rxjs";
import { create } from "@bufbuild/protobuf";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { parser_pb, MimeType, RunmeMetadataKey } from "../contexts/CellContext";
import type { StreamsLike } from "@runmedev/renderers";
import { APPKERNEL_RUNNER_NAME } from "./runtime/appKernel";

const mockRunner = {
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

const getWithFallback = vi.fn(() => mockRunner);
vi.mock("./runtime/runnersManager", () => ({
  DEFAULT_RUNNER_PLACEHOLDER: "<default>",
  getRunnersManager: () => ({ getWithFallback }),
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
