// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useMemo, useRef } from "react";

import type { PersistedConsoleCellRow } from "./model";

const ALT = 1 << 9;
const SHIFT = 1 << 10;
const ENTER = 1;
const UP = 2;
const DOWN = 3;
const KEY_N = 4;
const KEY_P = 5;

let storedSessionId = "session-1";
let storedCells: PersistedConsoleCellRow[] = [];
const touchedSessions: string[] = [];

const kernelBehavior = vi.fn(
  async (hooks: { onStdout?: (data: string) => void; onStderr?: (data: string) => void }, code: string) => {
    hooks.onStdout?.(`ran:${code}\n`);
    return {
      exitCode: 0,
      result: undefined,
    };
  },
);

vi.mock("../../contexts/RunnersContext", () => ({
  useRunners: () => ({
    updateRunner: vi.fn(),
    deleteRunner: vi.fn(),
    setDefaultRunner: vi.fn(),
  }),
}));

vi.mock("../../contexts/WorkspaceContext", () => ({
  useWorkspace: () => ({
    getItems: () => [],
    addItem: vi.fn(),
    removeItem: vi.fn(),
  }),
}));

vi.mock("../../contexts/CurrentDocContext", () => ({
  useCurrentDoc: () => ({
    getCurrentDoc: () => null,
    setCurrentDoc: vi.fn(),
  }),
}));

vi.mock("../../contexts/NotebookContext", () => ({
  useNotebookContext: () => ({
    getNotebookData: () => null,
    useNotebookList: () => [],
  }),
}));

vi.mock("../../contexts/FilesystemStoreContext", () => ({
  useFilesystemStore: () => ({
    fsStore: null,
    setFsStore: vi.fn(),
  }),
}));

vi.mock("../../contexts/NotebookStoreContext", () => ({
  useNotebookStore: () => ({
    store: null,
  }),
}));

vi.mock("../../lib/runtime/AppState", () => ({
  appState: {
    localNotebooks: null,
    setFilesystemStore: vi.fn(),
  },
}));

vi.mock("../../lib/runtime/runmeConsole", () => ({
  createRunmeConsoleApi: () => ({}),
}));

vi.mock("../../lib/runtime/appJsGlobals", () => ({
  createAppJsGlobals: () => ({}),
}));

vi.mock("../../storage/fs", () => ({
  FilesystemNotebookStore: class {},
  isFileSystemAccessSupported: () => false,
}));

vi.mock("../../lib/runner", () => ({
  Runner: class {
    constructor(public readonly args: Record<string, unknown>) {}
  },
}));

vi.mock("../../lib/runtime/jsKernel", () => ({
  JSKernel: class {
    private readonly hooks: Record<string, unknown>;

    constructor(args: { hooks?: Record<string, unknown> }) {
      this.hooks = args.hooks ?? {};
    }

    async run(code: string) {
      return kernelBehavior(this.hooks, code);
    }
  },
}));

vi.mock("../Actions/Actions", () => ({
  ActionOutputItems: ({ outputs }: { outputs: Array<{ items?: Array<{ data?: Uint8Array }> }> }) => {
    const decoder = new TextDecoder();
    const text = outputs
      .flatMap((output) => output.items ?? [])
      .map((item) => decoder.decode(item?.data ?? new Uint8Array()))
      .join("");
    return <div data-testid="mock-output-items">{text}</div>;
  },
}));

vi.mock("./storage", () => ({
  appConsoleStorage: {
    async createSession() {
      return {
        id: storedSessionId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },
    async loadLatestSession() {
      if (storedCells.length === 0) {
        return null;
      }
      return {
        session: {
          id: storedSessionId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        cells: storedCells,
      };
    },
    async saveCells(rows: PersistedConsoleCellRow[]) {
      storedCells = rows.map((row) => ({ ...row }));
    },
    async touchSession(sessionId: string) {
      touchedSessions.push(sessionId);
    },
  },
}));

vi.mock("../Actions/Editor", () => ({
  default: ({
    id,
    value,
    readOnly,
    ariaLabel,
    onChange,
    onMount,
  }: {
    id: string;
    value: string;
    readOnly?: boolean;
    ariaLabel?: string;
    onChange: (value: string) => void;
    onMount?: (editor: any, monaco: any) => void;
  }) => {
    const commandsRef = useRef(new Map<number, () => void>());

    const editorRef = useMemo(
      () => ({
        addCommand: (key: number, handler: () => void) => {
          commandsRef.current.set(key, handler);
        },
        focus: vi.fn(),
      }),
      [],
    );

    useEffect(() => {
      onMount?.(editorRef, {
        KeyMod: { Alt: ALT, Shift: SHIFT },
        KeyCode: {
          Enter: ENTER,
          UpArrow: UP,
          DownArrow: DOWN,
          KeyN: KEY_N,
          KeyP: KEY_P,
        },
      });
      // Monaco only invokes the consumer mount callback once per editor instance.
      // Keep the mock aligned so closure-related regressions are exercised.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
      <textarea
        aria-label={ariaLabel}
        data-testid={id}
        readOnly={readOnly}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          const code =
            event.key === "Enter"
              ? ENTER
              : event.key === "ArrowUp"
                ? UP
                : event.key === "ArrowDown"
                  ? DOWN
                  : event.key.toLowerCase() === "n"
                    ? KEY_N
                    : event.key.toLowerCase() === "p"
                      ? KEY_P
                  : null;
          const modifier = event.shiftKey ? SHIFT : event.altKey ? ALT : null;
          const handler =
            code && modifier !== null ? commandsRef.current.get(modifier | code) : undefined;
          if (!handler) {
            return;
          }
          event.preventDefault();
          handler();
        }}
      />
    );
  },
}));

import AppConsole from "./AppConsole";
import { __resetAppConsoleDataForTests } from "../../lib/appConsole/appConsoleController";

function getCurrentCell(): HTMLElement {
  const current = document.querySelector(
    '[data-testid="app-console-cell"][data-current="true"]',
  );
  if (!(current instanceof HTMLElement)) {
    throw new Error("Current app console cell not found");
  }
  return current;
}

function currentInput(): HTMLTextAreaElement {
  const input = screen.getByLabelText("App Console input");
  if (!(input instanceof HTMLTextAreaElement)) {
    throw new Error("Current app console input not found");
  }
  return input;
}

async function flushPersistence() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  });
}

describe("AppConsole", () => {
  beforeEach(() => {
    __resetAppConsoleDataForTests();
    storedSessionId = "session-1";
    storedCells = [];
    touchedSessions.length = 0;
    kernelBehavior.mockReset();
    kernelBehavior.mockImplementation(async (hooks, code: string) => {
      hooks.onStdout?.(`ran:${code}\n`);
      return {
        exitCode: 0,
        result: undefined,
      };
    });
  });

  it("runs draft cells append-only and creates a new draft", async () => {
    render(<AppConsole showHeader={false} />);

    await screen.findByLabelText("App Console input");
    fireEvent.change(currentInput(), { target: { value: 'console.log("hello")' } });
    fireEvent.keyDown(currentInput(), { key: "Enter", shiftKey: true });

    await waitFor(() => {
      expect(screen.getAllByTestId("app-console-cell")).toHaveLength(2);
    });

    const cells = screen.getAllByTestId("app-console-cell");
    expect(cells[0].getAttribute("data-status")).toBe("success");
    expect(cells[1].getAttribute("data-status")).toBe("draft");
    expect(cells[1].getAttribute("data-current")).toBe("true");
    expect(screen.getByText('ran:console.log("hello")')).toBeTruthy();
  });

  it("preserves the in-progress draft while browsing history", async () => {
    render(<AppConsole showHeader={false} />);

    await screen.findByLabelText("App Console input");

    fireEvent.change(currentInput(), { target: { value: "first()" } });
    fireEvent.keyDown(currentInput(), { key: "Enter", shiftKey: true });
    await waitFor(() => expect(screen.getAllByTestId("app-console-cell")).toHaveLength(2));

    fireEvent.change(currentInput(), { target: { value: "second()" } });
    fireEvent.keyDown(currentInput(), { key: "Enter", shiftKey: true });
    await waitFor(() => expect(screen.getAllByTestId("app-console-cell")).toHaveLength(3));

    fireEvent.change(currentInput(), { target: { value: "partial draft" } });

    fireEvent.click(screen.getByTestId("app-console-history-previous"));
    expect(currentInput().value).toBe("second()");

    fireEvent.click(screen.getByTestId("app-console-history-previous"));
    expect(currentInput().value).toBe("first()");

    fireEvent.click(screen.getByTestId("app-console-history-next"));
    expect(currentInput().value).toBe("second()");

    fireEvent.click(screen.getByTestId("app-console-history-next"));
    expect(currentInput().value).toBe("partial draft");
  });

  it("renders history controls with tooltips", async () => {
    render(<AppConsole showHeader={false} />);

    await screen.findByLabelText("App Console input");
    expect(screen.getByTestId("app-console-history-previous").getAttribute("title")).toBe(
      "Previous history entry (Alt+P)",
    );
    expect(screen.getByTestId("app-console-history-next").getAttribute("title")).toBe(
      "Next history entry (Alt+N)",
    );
  });

  it("supports Alt+P and Alt+N history shortcuts", async () => {
    render(<AppConsole showHeader={false} />);

    await screen.findByLabelText("App Console input");

    fireEvent.change(currentInput(), { target: { value: "first()" } });
    fireEvent.keyDown(currentInput(), { key: "Enter", shiftKey: true });
    await waitFor(() => expect(screen.getAllByTestId("app-console-cell")).toHaveLength(2));

    fireEvent.change(currentInput(), { target: { value: "second()" } });
    fireEvent.keyDown(currentInput(), { key: "Enter", shiftKey: true });
    await waitFor(() => expect(screen.getAllByTestId("app-console-cell")).toHaveLength(3));

    fireEvent.change(currentInput(), { target: { value: "partial draft" } });

    fireEvent.keyDown(currentInput(), { key: "p", altKey: true });
    expect(currentInput().value).toBe("second()");

    fireEvent.keyDown(currentInput(), { key: "p", altKey: true });
    expect(currentInput().value).toBe("first()");

    fireEvent.keyDown(currentInput(), { key: "n", altKey: true });
    expect(currentInput().value).toBe("second()");

    fireEvent.keyDown(currentInput(), { key: "n", altKey: true });
    expect(currentInput().value).toBe("partial draft");
  });

  it("updates history button state even when browsing does not change the draft text", async () => {
    render(<AppConsole showHeader={false} />);

    await screen.findByLabelText("App Console input");

    fireEvent.change(currentInput(), { target: { value: "first()" } });
    fireEvent.keyDown(currentInput(), { key: "Enter", shiftKey: true });
    await waitFor(() => expect(screen.getAllByTestId("app-console-cell")).toHaveLength(2));

    fireEvent.change(currentInput(), { target: { value: "first()" } });

    const previousButton = screen.getByTestId("app-console-history-previous");
    const nextButton = screen.getByTestId("app-console-history-next");

    expect(previousButton.getAttribute("disabled")).toBeNull();
    expect(nextButton.getAttribute("disabled")).not.toBeNull();

    fireEvent.click(previousButton);

    expect(currentInput().value).toBe("first()");
    expect(previousButton.getAttribute("disabled")).not.toBeNull();
    expect(nextButton.getAttribute("disabled")).toBeNull();
  });

  it("copies a frozen cell back into the current draft", async () => {
    render(<AppConsole showHeader={false} />);

    await screen.findByLabelText("App Console input");
    fireEvent.change(currentInput(), { target: { value: "app.runners.get()" } });
    fireEvent.click(screen.getByTestId("app-console-cell-run"));

    await waitFor(() => expect(screen.getAllByTestId("app-console-cell")).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId("app-console-cell-copy-to-draft")[0]);

    expect(currentInput().value).toBe("app.runners.get()");
  });

  it("restores persisted cells after remount", async () => {
    const firstRender = render(<AppConsole showHeader={false} />);

    await screen.findByLabelText("App Console input");
    fireEvent.change(currentInput(), { target: { value: "persisted()" } });
    fireEvent.keyDown(currentInput(), { key: "Enter", shiftKey: true });
    await waitFor(() => expect(screen.getAllByTestId("app-console-cell")).toHaveLength(2));
    await flushPersistence();

    firstRender.unmount();
    render(<AppConsole showHeader={false} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("app-console-cell")).toHaveLength(2);
    });
    expect(screen.getByText("persisted()")).toBeTruthy();
    expect(getCurrentCell().getAttribute("data-status")).toBe("draft");
  });
});
