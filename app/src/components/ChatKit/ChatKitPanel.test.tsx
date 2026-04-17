// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { create } from "@bufbuild/protobuf";
import { ChatkitStateSchema } from "../../protogen/oaiproto/aisre/notebooks_pb.js";

type HarnessAdapter = "responses-direct" | "codex" | "codex-wasm";

let harnessState: {
  harnesses: Array<{ name: string; baseUrl: string; adapter: HarnessAdapter }>;
  defaultHarness: { name: string; baseUrl: string; adapter: HarnessAdapter };
  defaultHarnessName: string;
};
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
const harnessManagerMock = {
  setDefault: vi.fn(),
};
const { appLoggerMock } = vi.hoisted(() => ({
  appLoggerMock: {
    info: vi.fn(),
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
  useTransport: vi.fn(),
  connectProxy: vi.fn(async () => {}),
  connectWasm: vi.fn(async () => {}),
  disconnect: vi.fn(),
  setAuthorizationResolver: vi.fn(),
};
const codexControllerMock = {
  setSelectedProject: vi.fn(),
  refreshHistory: vi.fn(async () => {}),
  startNewChat: vi.fn(),
  ensureActiveThread: vi.fn(async () => {
    codexConversationState.currentThreadId = "thread-bootstrap";
    codexConversationState.currentTurnId = null;
    return {
      id: "thread-bootstrap",
      title: "Bootstrap Thread",
      previousResponseId: "",
      items: [],
    };
  }),
  getSnapshot: vi.fn(() => ({
    currentThreadId: codexConversationState.currentThreadId,
    currentTurnId: codexConversationState.currentTurnId,
  })),
  selectThread: vi.fn(async (threadId: string) => ({
    id: threadId,
    previousResponseId: "turn-1",
  })),
};
const codexFetchMock = vi.fn(async () => new Response(null, { status: 200 }));
const responsesDirectFetchMock = vi.fn(async () => new Response(null, { status: 200 }));

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
    useNotebookList: () => [],
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

vi.mock("../../lib/runtime/codexAppServerClient", () => ({
  getCodexAppServerClient: () => proxyMock,
}));

vi.mock("../../lib/runtime/codexChatkitFetch", () => ({
  createCodexChatkitFetch: () => codexFetchMock,
}));

vi.mock("../../lib/runtime/responsesDirectChatkitFetch", () => ({
  createResponsesDirectChatkitFetch: () => responsesDirectFetchMock,
}));

vi.mock("../../lib/runtime/responsesDirectConfigManager", () => ({
  responsesDirectConfigManager: {
    getSnapshot: () => ({
      authMethod: "api_key",
      apiKey: "sk-test",
    }),
  },
  useResponsesDirectConfigSnapshot: () => ({
    authMethod: "api_key",
    apiKey: "sk-test",
  }),
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
    getHarnessManager: () => harnessManagerMock,
  };
});

vi.mock("../../lib/logging/runtime", () => ({
  appLogger: appLoggerMock,
}));

import ChatKitPanel from "./ChatKitPanel";

describe("ChatKitPanel codex harness routing", () => {
  beforeEach(() => {
    harnessState = {
      harnesses: [
        {
          name: "default",
          baseUrl: "http://127.0.0.1:31337",
          adapter: "responses-direct",
        },
        {
          name: "local-codex",
          baseUrl: "http://127.0.0.1:31337",
          adapter: "codex",
        },
        {
          name: "local-codex-wasm",
          baseUrl: "",
          adapter: "codex-wasm",
        },
      ],
      defaultHarness: {
        name: "default",
        baseUrl: "http://127.0.0.1:31337",
        adapter: "responses-direct",
      },
      defaultHarnessName: "default",
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
    harnessManagerMock.setDefault.mockClear();
    bridgeMock.connect.mockClear();
    bridgeMock.disconnect.mockClear();
    bridgeMock.setHandler.mockClear();
    bridgeMock.subscribe.mockClear();
    bridgeMock.getSnapshot.mockClear();
    proxyMock.useTransport.mockClear();
    proxyMock.connectProxy.mockClear();
    proxyMock.connectWasm.mockClear();
    proxyMock.disconnect.mockClear();
    proxyMock.setAuthorizationResolver.mockClear();
    codexControllerMock.setSelectedProject.mockClear();
    codexControllerMock.refreshHistory.mockClear();
    codexControllerMock.startNewChat.mockClear();
    codexControllerMock.ensureActiveThread.mockClear();
    codexControllerMock.getSnapshot.mockClear();
    codexControllerMock.selectThread.mockClear();
    codexFetchMock.mockClear();
    responsesDirectFetchMock.mockClear();
    approvalMgrMock.failAll.mockClear();
    appLoggerMock.info.mockClear();
    appLoggerMock.error.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("routes ChatKit to responses-direct and does not connect codex bridge", () => {
    render(<ChatKitPanel />);

    const config = useChatKitMock.mock.calls.at(0)?.[0];
    expect(config.api.url).toBe("http://127.0.0.1:31337/responses/direct/chatkit");
    expect(bridgeMock.connect).not.toHaveBeenCalled();
    expect(bridgeMock.disconnect).toHaveBeenCalled();
  });

  it("renders a harness selector and switches the default harness", async () => {
    render(<ChatKitPanel />);

    const selector = screen.getByTestId("chatkit-harness-select") as HTMLSelectElement;
    expect(selector.value).toBe("default");
    expect(selector.options).toHaveLength(3);

    await act(async () => {
      fireEvent.change(selector, {
        target: { value: "local-codex-wasm" },
      });
    });

    expect(harnessManagerMock.setDefault).toHaveBeenCalledWith("local-codex-wasm");
  });

  it("routes ChatKit to responses-direct adapter URL and uses responses-direct fetch", async () => {
    harnessState.defaultHarness.adapter = "responses-direct";

    render(<ChatKitPanel />);

    const config = useChatKitMock.mock.calls.at(0)?.[0];
    expect(config.api.url).toBe("http://127.0.0.1:31337/responses/direct/chatkit");

    await act(async () => {
      await config.api.fetch("http://127.0.0.1:31337/responses/direct/chatkit", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "threads.create",
          params: {
            input: {
              content: [{ type: "input_text", text: "hello" }],
            },
          },
        }),
      });
    });

    expect(responsesDirectFetchMock).toHaveBeenCalled();
    expect(codexFetchMock).not.toHaveBeenCalled();
    expect(bridgeMock.connect).not.toHaveBeenCalled();
  });

  it("routes ChatKit to codex-wasm adapter URL and initializes the wasm app-server client", async () => {
    harnessState.defaultHarness.adapter = "codex-wasm";

    render(<ChatKitPanel />);

    const config = useChatKitMock.mock.calls.at(0)?.[0];
    expect(config.api.url).toBe("http://127.0.0.1:31337/codex/wasm/chatkit");

    await act(async () => {
      await config.api.fetch("http://127.0.0.1:31337/codex/wasm/chatkit", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "threads.create",
          params: {
            input: {
              content: [{ type: "input_text", text: "hello codex wasm" }],
            },
          },
        }),
      });
    });

    expect(codexFetchMock).toHaveBeenCalled();
    await waitFor(() => expect(proxyMock.useTransport).toHaveBeenCalledWith("wasm"));
    await waitFor(() =>
      expect(proxyMock.connectWasm).toHaveBeenCalledWith({
        apiKey: "sk-test",
      }),
    );
    expect(bridgeMock.connect).not.toHaveBeenCalled();
  });

  it("handles ExecuteCode params with top-level code for NotebookService tool names", async () => {
    render(<ChatKitPanel />);
    const config = useChatKitMock.mock.calls.at(0)?.[0];

    const result = await config.onClientTool({
      name: "agent_tools_v1_NotebookService_ExecuteCode",
      params: {
        call_id: "call-top-level",
        previous_response_id: "resp-1",
        code: "console.log('ok')",
      },
    });

    expect(result.callId).toBe("call-top-level");
    expect(result.previousResponseId).toBe("resp-1");
    expect(String(result.clientError ?? "")).not.toContain("Failed to decode tool params");
    expect(String(result.clientError ?? "")).not.toContain('key "code" is unknown');
  });

  it("handles ExecuteCode params for direct ExecuteCode tool name", async () => {
    render(<ChatKitPanel />);
    const config = useChatKitMock.mock.calls.at(0)?.[0];

    const result = await config.onClientTool({
      name: "ExecuteCode",
      params: {
        call_id: "call-direct",
        code: "console.log('direct')",
      },
    });

    expect(result.callId).toBe("call-direct");
    expect(String(result.clientError ?? "")).not.toContain("Failed to decode tool params");
    expect(String(result.clientError ?? "")).not.toContain('key "code" is unknown');
  });

  it("returns unknown tool error for unrecognized tool names", async () => {
    render(<ChatKitPanel />);
    const config = useChatKitMock.mock.calls.at(0)?.[0];

    const result = await config.onClientTool({
      name: "unknown_tool_name",
      params: {
        call_id: "",
        previous_response_id: "resp-1",
        code: "console.log('payload-shape')",
      },
    });

    expect(String(result.clientError ?? "")).toContain("Unknown tool unknown_tool_name");
    expect(String(result.clientError ?? "")).not.toContain("Failed to decode tool params");
    expect(String(result.clientError ?? "")).not.toContain('key "code" is unknown');
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
      expect(proxyMock.useTransport).toHaveBeenCalledWith("proxy"),
    );
    await waitFor(() =>
      expect(proxyMock.connectProxy).toHaveBeenCalledWith(
        "ws://127.0.0.1:31337/codex/app-server/ws",
        "Bearer test-id-token",
      ),
    );
    expect(bridgeMock.setHandler).toHaveBeenCalled();
    expect(config.history.enabled).toBe(false);
    expect(config.header.title.text).toBe("Runme Repo");
    expect(appLoggerMock.info).toHaveBeenCalledWith(
      "ChatKit host configured",
      expect.objectContaining({
        attrs: expect.objectContaining({
          scope: "chatkit.panel",
          adapter: "codex",
          apiUrl: "http://127.0.0.1:31337/codex/chatkit",
          selectedProjectId: "project-1",
        }),
      }),
    );
  });

  it("bootstraps a codex thread on load and passes it to ChatKit as initialThread", async () => {
    harnessState.defaultHarness.adapter = "codex";

    render(<ChatKitPanel />);

    await waitFor(() => expect(codexControllerMock.ensureActiveThread).toHaveBeenCalled());
    expect(useChatKitMock.mock.calls.at(-1)?.[0]?.initialThread).toBe("thread-bootstrap");
    await waitFor(() =>
      expect(setThreadIdMock).toHaveBeenCalledWith("thread-bootstrap"),
    );
  });

  it("uses the synced codex thread state for Codex fetch requests", async () => {
    harnessState.defaultHarness.adapter = "codex";
    codexFetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    render(<ChatKitPanel />);

    await waitFor(() => expect(codexControllerMock.ensureActiveThread).toHaveBeenCalled());
    const config = useChatKitMock.mock.calls.at(-1)?.[0];
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
              content: [{ type: "input_text", text: "print('hello')" }],
            },
          },
        }),
      });
    });

    const lastCall = codexFetchMock.mock.calls.at(-1);
    expect(lastCall).toBeTruthy();
    const init = lastCall?.[1] as RequestInit | undefined;
    expect(typeof init?.body).toBe("string");
    const payload = JSON.parse(String(init?.body));
    expect(payload.chatkit_state).toEqual(
      expect.objectContaining({
        threadId: "thread-bootstrap",
      }),
    );
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
      "http://127.0.0.1:31337/responses/direct/chatkit",
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
      expect(proxyMock.connectProxy).toHaveBeenCalledWith(
        "ws://127.0.0.1:31337/codex/app-server/ws",
        "Bearer test-id-token",
      ),
    );

    harnessState.defaultHarness = {
      ...harnessState.defaultHarness,
      adapter: "responses-direct",
    };
    rerender(<ChatKitPanel />);

    expect(useChatKitMock.mock.calls.at(-1)?.[0]?.api?.url).toBe(
      "http://127.0.0.1:31337/responses/direct/chatkit",
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

  it("ignores codex chatkit state events and does not resync ChatKit host", async () => {
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

    expect(setThreadIdMock).not.toHaveBeenCalledWith("thread-1");
    expect(fetchUpdatesMock).not.toHaveBeenCalled();
    expect(appLoggerMock.info).toHaveBeenCalledWith("Ignoring Codex ChatKit state event", {
      attrs: {
        scope: "chatkit.panel",
        adapter: "codex",
        threadId: "thread-1",
        previousResponseId: "resp-1",
      },
    });
    expect(appLoggerMock.info).not.toHaveBeenCalledWith(
      "Received ChatKit state event",
      expect.anything(),
    );
  });

  it("surfaces response.failed SSE events as an in-panel error", async () => {
    harnessState.defaultHarness.adapter = "codex";
    const encoder = new TextEncoder();
    codexFetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"type":"response.failed","error":{"message":"Timed out waiting for codex turn completion"}}\n\n',
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
              content: [{ type: "input_text", text: 'print(\"hello\")' }],
            },
          },
        }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("codex-stream-error").textContent).toContain(
      "Timed out waiting for codex turn completion",
    );
    expect(appLoggerMock.error).toHaveBeenCalledWith(
      "ChatKit response stream failed",
      {
        attrs: {
          scope: "chatkit.panel",
          adapter: "codex",
          error: "Timed out waiting for codex turn completion",
        },
      },
    );
  });

  it("does not invoke ChatKit host sync for codex state events even if host methods would fail", async () => {
    harnessState.defaultHarness.adapter = "codex";
    fetchUpdatesMock.mockRejectedValueOnce(
      new TypeError("Cannot read properties of undefined (reading 'data')"),
    );
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
              content: [{ type: "input_text", text: 'print(\"hello\")' }],
            },
          },
        }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setThreadIdMock).not.toHaveBeenCalledWith("thread-1");
    expect(fetchUpdatesMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("codex-stream-error")).toBeNull();
    expect(appLoggerMock.error).not.toHaveBeenCalledWith(
      "Failed to sync Codex state into ChatKit host",
      expect.anything(),
    );
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
    expect(setThreadIdMock).toHaveBeenCalledWith("thread-bootstrap");
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
        adapter: "responses-direct",
        baseUrl: "http://127.0.0.1:31337",
        error: "thread is not materialized yet",
      },
    });
  });

  it("logs chatkit thread changes through appLogger", () => {
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
      config.onThreadChange({ threadId: "thread-1" });
    });

    expect(appLoggerMock.info).toHaveBeenCalledWith(
      "ChatKit thread changed",
      expect.objectContaining({
        attrs: expect.objectContaining({
          scope: "chatkit.panel",
          adapter: "codex",
          threadId: "thread-1",
          localThreadId: "",
          localPreviousResponseId: "",
          codexCurrentThreadId: null,
          codexCurrentTurnId: null,
        }),
      }),
    );
  });

  it("ignores null chatkit thread changes when codex already has an active thread", () => {
    harnessState.defaultHarness.adapter = "codex";
    codexConversationState.currentThreadId = "thread-1";
    codexConversationState.currentTurnId = "turn-1";
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
      config.onThreadChange({ threadId: null });
    });

    expect(appLoggerMock.info).toHaveBeenCalledWith(
      "Ignoring null ChatKit thread change while Codex thread is active",
      expect.objectContaining({
        attrs: expect.objectContaining({
          scope: "chatkit.panel",
          adapter: "codex",
          threadId: null,
          codexCurrentThreadId: "thread-1",
          codexCurrentTurnId: "turn-1",
        }),
      }),
    );
  });
});
