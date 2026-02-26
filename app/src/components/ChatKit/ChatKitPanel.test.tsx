// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { create } from "@bufbuild/protobuf";
import { ChatkitStateSchema } from "../../protogen/oaiproto/aisre/notebooks_pb.js";

type HarnessAdapter = "responses" | "codex";

let harnessState: { defaultHarness: { name: string; baseUrl: string; adapter: HarnessAdapter } };
let codexProjectsState: {
  projects: Array<{ id: string; name: string }>;
  defaultProject: { id: string; name: string };
};
let codexConversationState: {
  selectedProject: { id: string; name: string };
  threads: Array<{ id: string; title: string; updatedAt?: string; previousResponseId?: string }>;
  currentThreadId: string | null;
  currentTurnId: string | null;
  loadingHistory: boolean;
  historyError: string | null;
};
let bridgeSnapshot: { state: "idle" | "connecting" | "open" | "closed" | "error"; url: string | null; lastError: string | null };
let bridgeListener: (() => void) | null;
let setThreadIdMock: ReturnType<typeof vi.fn>;
let fetchUpdatesMock: ReturnType<typeof vi.fn>;
const useChatKitMock = vi.fn();
const { appLoggerMock } = vi.hoisted(() => ({
  appLoggerMock: {
    error: vi.fn(),
  },
}));
const bridgeMock = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  setHandler: vi.fn(),
  subscribe: vi.fn((listener: () => void) => {
    bridgeListener = listener;
    return () => {
      if (bridgeListener === listener) {
        bridgeListener = null;
      }
    };
  }),
  getSnapshot: vi.fn(() => bridgeSnapshot),
};
const approvalMgrMock = {
  requestApproval: vi.fn(),
  approve: vi.fn(),
  failAll: vi.fn(),
};
const proxyMock = {
  connect: vi.fn(async () => {}),
  disconnect: vi.fn(),
};
const codexControllerMock = {
  setSelectedProject: vi.fn(),
  refreshHistory: vi.fn(async () => {}),
  startNewChat: vi.fn(),
  selectThread: vi.fn(async (threadId: string) => ({
    id: threadId,
    previousResponseId: "turn-1",
  })),
};
const codexFetchMock = vi.fn(async () => new Response(null, { status: 200 }));

vi.mock("@openai/chatkit-react", () => ({
  ChatKit: ({ className }: { className?: string }) => (
    <div data-testid="chatkit-root" className={className} />
  ),
  ChatKitIcon: {},
  useChatKit: (...args: unknown[]) => useChatKitMock(...args),
}));

vi.mock("../../contexts/CellContext", () => ({
  parser_pb: {},
  RunmeMetadataKey: {
    ExitCode: "exitCode",
  },
  useCell: () => ({
    getChatkitState: () => create(ChatkitStateSchema, {}),
    setChatkitState: vi.fn(),
  }),
}));

vi.mock("../../contexts/NotebookContext", () => ({
  useNotebookContext: () => ({
    getNotebookData: () => undefined,
    useNotebookSnapshot: () => ({ notebook: { cells: [] } }),
  }),
}));

vi.mock("../../contexts/OutputContext", () => ({
  useOutput: () => ({
    getAllRenderers: () => new Map(),
  }),
}));

vi.mock("../../contexts/CurrentDocContext", () => ({
  useCurrentDoc: () => ({
    getCurrentDoc: () => null,
  }),
}));

vi.mock("../../token", () => ({
  getAccessToken: vi.fn(async () => "test-access-token"),
  getAuthData: vi.fn(async () => ({ idToken: "test-id-token" })),
}));

vi.mock("../../browserAdapter.client", () => ({
  getBrowserAdapter: () => ({
    loginWithRedirect: vi.fn(),
  }),
}));

vi.mock("../../lib/runtime/codexToolBridge", () => ({
  getCodexToolBridge: () => bridgeMock,
}));

vi.mock("../../lib/runtime/codexExecuteApprovalManager", () => ({
  getCodexExecuteApprovalManager: () => approvalMgrMock,
}));

vi.mock("../../lib/runtime/codexAppServerProxyClient", () => ({
  getCodexAppServerProxyClient: () => proxyMock,
}));

vi.mock("../../lib/runtime/codexChatkitFetch", () => ({
  createCodexChatkitFetch: () => codexFetchMock,
}));

vi.mock("../../lib/runtime/codexConversationController", () => ({
  getCodexConversationController: () => codexControllerMock,
  useCodexConversationSnapshot: () => codexConversationState,
}));

vi.mock("../../lib/runtime/codexProjectManager", () => ({
  useCodexProjects: () => codexProjectsState,
}));

vi.mock("../../lib/runtime/harnessManager", async () => {
  const actual = await vi.importActual<typeof import("../../lib/runtime/harnessManager")>(
    "../../lib/runtime/harnessManager"
  );
  return {
    ...actual,
    useHarness: () => harnessState,
  };
});

vi.mock("../../lib/logging/runtime", () => ({
  appLogger: appLoggerMock,
}));

import ChatKitPanel from "./ChatKitPanel";

describe("ChatKitPanel codex harness routing", () => {
  beforeEach(() => {
    harnessState = {
      defaultHarness: {
        name: "default",
        baseUrl: "http://127.0.0.1:31337",
        adapter: "responses",
      },
    };
    codexProjectsState = {
      projects: [{ id: "project-1", name: "Runme Repo" }],
      defaultProject: { id: "project-1", name: "Runme Repo" },
    };
    codexConversationState = {
      selectedProject: { id: "project-1", name: "Runme Repo" },
      threads: [],
      currentThreadId: null,
      currentTurnId: null,
      loadingHistory: false,
      historyError: null,
    };
    bridgeSnapshot = {
      state: "idle",
      url: null,
      lastError: null,
    };
    bridgeListener = null;
    setThreadIdMock = vi.fn(async () => {});
    fetchUpdatesMock = vi.fn(async () => {});
    useChatKitMock.mockReset();
    useChatKitMock.mockReturnValue({
      control: {},
      setThreadId: setThreadIdMock,
      fetchUpdates: fetchUpdatesMock,
    });
    bridgeMock.connect.mockClear();
    bridgeMock.disconnect.mockClear();
    bridgeMock.setHandler.mockClear();
    bridgeMock.subscribe.mockClear();
    bridgeMock.getSnapshot.mockClear();
    proxyMock.connect.mockClear();
    proxyMock.disconnect.mockClear();
    codexControllerMock.setSelectedProject.mockClear();
    codexControllerMock.refreshHistory.mockClear();
    codexControllerMock.startNewChat.mockClear();
    codexControllerMock.selectThread.mockClear();
    codexFetchMock.mockClear();
    approvalMgrMock.failAll.mockClear();
    appLoggerMock.error.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("routes ChatKit to /chatkit and does not connect codex bridge for responses harness", () => {
    render(<ChatKitPanel />);

    const config = useChatKitMock.mock.calls.at(0)?.[0];
    expect(config.api.url).toBe("http://127.0.0.1:31337/chatkit");
    expect(bridgeMock.connect).not.toHaveBeenCalled();
    expect(bridgeMock.disconnect).toHaveBeenCalled();
  });

  it("routes ChatKit to /codex/app-server/ws and connects codex bridge + proxy websocket", async () => {
    harnessState.defaultHarness.adapter = "codex";

    render(<ChatKitPanel />);

    const config = useChatKitMock.mock.calls.at(0)?.[0];
    expect(config.api.url).toBe("http://127.0.0.1:31337/codex/chatkit");
    await waitFor(() =>
      expect(bridgeMock.connect).toHaveBeenCalledWith(
        "ws://127.0.0.1:31337/codex/ws",
        "Bearer test-id-token",
      ),
    );
    await waitFor(() =>
      expect(proxyMock.connect).toHaveBeenCalledWith(
        "ws://127.0.0.1:31337/codex/app-server/ws",
        "Bearer test-id-token",
      ),
    );
    expect(bridgeMock.setHandler).toHaveBeenCalled();
    expect(config.history.enabled).toBe(false);
    expect(config.header.title.text).toBe("Runme Repo");
  });

  it("clears pending approvals on codex bridge disconnect without showing an in-panel error banner", () => {
    harnessState.defaultHarness.adapter = "codex";
    bridgeSnapshot = {
      state: "error",
      url: "ws://127.0.0.1:31337/codex/ws",
      lastError: "codex_ws_already_connected",
    };

    render(<ChatKitPanel />);
    act(() => {
      bridgeListener?.();
    });

    expect(screen.queryByTestId("codex-bridge-error")).toBeNull();
    expect(approvalMgrMock.failAll).toHaveBeenCalledWith("Codex bridge disconnected");
  });

  it("switches chatkit endpoint immediately when harness default changes", async () => {
    const { rerender } = render(<ChatKitPanel />);

    expect(useChatKitMock.mock.calls.at(-1)?.[0]?.api?.url).toBe(
      "http://127.0.0.1:31337/chatkit",
    );

    harnessState.defaultHarness = {
      ...harnessState.defaultHarness,
      adapter: "codex",
    };
    rerender(<ChatKitPanel />);

    expect(useChatKitMock.mock.calls.at(-1)?.[0]?.api?.url).toBe(
      "http://127.0.0.1:31337/codex/chatkit",
    );
    await waitFor(() =>
      expect(bridgeMock.connect).toHaveBeenCalledWith(
        "ws://127.0.0.1:31337/codex/ws",
        "Bearer test-id-token",
      ),
    );
    await waitFor(() =>
      expect(proxyMock.connect).toHaveBeenCalledWith(
        "ws://127.0.0.1:31337/codex/app-server/ws",
        "Bearer test-id-token",
      ),
    );

    harnessState.defaultHarness = {
      ...harnessState.defaultHarness,
      adapter: "responses",
    };
    rerender(<ChatKitPanel />);

    expect(useChatKitMock.mock.calls.at(-1)?.[0]?.api?.url).toBe(
      "http://127.0.0.1:31337/chatkit",
    );
    expect(bridgeMock.disconnect).toHaveBeenCalled();
    expect(proxyMock.disconnect).toHaveBeenCalled();
  });

  it("renders the codex project drawer and conversation list", () => {
    harnessState.defaultHarness.adapter = "codex";
    codexConversationState.threads = [
      {
        id: "thread-1",
        title: "Investigate latency",
        updatedAt: "2026-02-26T00:00:00Z",
        previousResponseId: "turn-1",
      },
    ];

    render(<ChatKitPanel />);

    const config = useChatKitMock.mock.calls.at(0)?.[0];
    act(() => {
      config.header.leftAction.onClick();
    });

    expect(screen.getByTestId("codex-project-drawer")).toBeTruthy();
    expect(screen.getByTestId("codex-project-select")).toBeTruthy();
    expect(
      screen.getByTestId("codex-thread-thread-1").textContent ?? "",
    ).toContain("Investigate latency");
  });

  it("selects a codex conversation from the drawer and refreshes ChatKit history", async () => {
    harnessState.defaultHarness.adapter = "codex";
    codexConversationState.threads = [
      {
        id: "thread-1",
        title: "Investigate latency",
        updatedAt: "2026-02-26T00:00:00Z",
        previousResponseId: "turn-1",
      },
    ];

    render(<ChatKitPanel />);

    const config = useChatKitMock.mock.calls.at(0)?.[0];
    act(() => {
      config.header.leftAction.onClick();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("codex-thread-thread-1"));
    });

    expect(codexControllerMock.selectThread).toHaveBeenCalledWith("thread-1");
    expect(setThreadIdMock).toHaveBeenCalledWith("thread-1");
    expect(fetchUpdatesMock).toHaveBeenCalled();
  });

  it("syncs codex chatkit state events back into ChatKit thread history", async () => {
    harnessState.defaultHarness.adapter = "codex";
    const encoder = new TextEncoder();
    codexFetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"type":"aisre.chatkit.state","item":{"state":{"threadId":"thread-1","previousResponseId":"resp-1"}}}\n\n',
              ),
            );
            controller.close();
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
          },
        },
      ),
    );

    render(<ChatKitPanel />);

    const config = useChatKitMock.mock.calls.at(0)?.[0];
    expect(config).toBeDefined();

    await act(async () => {
      await config.api.fetch("http://127.0.0.1:31337/codex/chatkit", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "threads.create",
          params: {
            input: {
              content: [{ type: "input_text", text: 'print("hello")' }],
            },
          },
        }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setThreadIdMock).toHaveBeenCalledWith("thread-1");
    expect(fetchUpdatesMock).toHaveBeenCalled();
  });

  it("switches codex projects and reloads history", async () => {
    harnessState.defaultHarness.adapter = "codex";
    codexProjectsState = {
      projects: [
        { id: "project-1", name: "Runme Repo" },
        { id: "project-2", name: "Docs Repo" },
      ],
      defaultProject: { id: "project-1", name: "Runme Repo" },
    };

    render(<ChatKitPanel />);

    const config = useChatKitMock.mock.calls.at(0)?.[0];
    act(() => {
      config.header.leftAction.onClick();
    });

    await act(async () => {
      fireEvent.change(screen.getByTestId("codex-project-select"), {
        target: { value: "project-2" },
      });
    });

    expect(codexControllerMock.setSelectedProject).toHaveBeenCalledWith("project-2");
    expect(codexControllerMock.startNewChat).toHaveBeenCalled();
    expect(codexControllerMock.refreshHistory).toHaveBeenCalled();
    expect(setThreadIdMock).toHaveBeenCalledWith(null);
  });

  it("logs chatkit errors through appLogger", () => {
    render(<ChatKitPanel />);

    const config = useChatKitMock.mock.calls.at(0)?.[0];
    expect(config).toBeDefined();

    act(() => {
      config.onError({ error: new Error("thread is not materialized yet") });
    });

    expect(appLoggerMock.error).toHaveBeenCalledWith("ChatKit error", {
      attrs: {
        scope: "chatkit.panel",
        adapter: "responses",
        baseUrl: "http://127.0.0.1:31337",
        error: "thread is not materialized yet",
      },
    });
  });
});
