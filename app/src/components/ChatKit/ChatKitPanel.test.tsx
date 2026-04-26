// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
let responsesDirectConfigState: {
  authMethod: string;
  apiKey: string;
};
let currentDocUriState: string | null;
let bridgeSnapshot: { state: "idle" | "connecting" | "open" | "closed" | "error"; url: string | null; lastError: string | null };
let setThreadIdMock: ReturnType<typeof vi.fn>;
let fetchUpdatesMock: ReturnType<typeof vi.fn>;
const harnessManagerMock = {
  setDefault: vi.fn(),
};
const codexProjectManagerMock = {
  setDefault: vi.fn(),
};
const { appLoggerMock, useChatKitMock, chatKitReactModuleMock } = vi.hoisted(() => ({
  appLoggerMock: {
    info: vi.fn(),
    error: vi.fn(),
  },
  useChatKitMock: vi.fn(),
  chatKitReactModuleMock: {
    ChatKit: ({ className }: { className?: string }) => (
      <div data-testid="chatkit-root" className={className} />
    ),
    ChatKitIcon: {},
    useChatKit: undefined as unknown,
  },
}));
chatKitReactModuleMock.useChatKit = useChatKitMock;
const bridgeMock = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  setHandler: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
  getSnapshot: vi.fn(() => bridgeSnapshot),
};
const proxyMock = {
  useTransport: vi.fn(),
  connectProxy: vi.fn(async () => {}),
  connectWasm: vi.fn(async () => {}),
  disconnect: vi.fn(),
  setCodeExecutor: vi.fn(),
  setAuthorizationResolver: vi.fn(),
};
const codexControllerMock = {
  subscribe: vi.fn(() => () => {}),
  setSelectedProject: vi.fn(),
  refreshHistory: vi.fn(async () => {}),
  newChat: vi.fn(() => {
    codexConversationState.currentThreadId = null;
    codexConversationState.currentTurnId = null;
  }),
  setSelectedModel: vi.fn(),
  streamUserMessage: vi.fn(async (_input: string, sink: { emit: (payload: unknown) => void }) => {
    sink.emit({ type: "response.created", response: { id: "resp-1" } });
    sink.emit({ type: "response.completed", response: { id: "resp-1" } });
  }),
  getSnapshot: vi.fn(() => ({
    selectedProject: codexConversationState.selectedProject,
    threads: codexConversationState.threads,
    currentThreadId: codexConversationState.currentThreadId,
    currentTurnId: codexConversationState.currentTurnId,
    loadingHistory: codexConversationState.loadingHistory,
    historyError: codexConversationState.historyError,
    selectedModel: "gpt-5.2",
  })),
  getThread: vi.fn(async (threadId: string) => ({
    id: threadId,
    title: "Investigate latency",
    items: [],
  })),
  listItems: vi.fn(async () => []),
  selectThread: vi.fn(async (threadId: string) => ({
    id: threadId,
    previousResponseId: "turn-1",
  })),
  interruptActiveTurn: vi.fn(async () => {}),
};

function getLatestChatKitConfig(): any {
  const config = useChatKitMock.mock.calls.at(-1)?.[0];
  expect(config).toBeDefined();
  return config;
}

async function waitForChatKitToRerender(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

vi.mock("../../lib/runtime/chatkitReact", () => chatKitReactModuleMock);

vi.mock("../../contexts/CellContext", () => ({
  parser_pb: {},
  RunmeMetadataKey: {
    ExitCode: "exitCode",
  },
}));

vi.mock("../../contexts/NotebookContext", () => ({
  useNotebookContext: () => ({
    getNotebookData: () => undefined,
    useNotebookSnapshot: () => ({ notebook: { cells: [] } }),
    useNotebookList: () => [],
  }),
}));

vi.mock("../../contexts/CurrentDocContext", () => ({
  useCurrentDoc: () => ({
    getCurrentDoc: () => currentDocUriState,
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

vi.mock("../../lib/runtime/codexAppServerClient", () => ({
  getCodexAppServerClient: () => proxyMock,
}));

vi.mock("../../lib/runtime/responsesDirectConfigManager", () => ({
  responsesDirectConfigManager: {
    getSnapshot: () => responsesDirectConfigState,
  },
  useResponsesDirectConfigSnapshot: () => responsesDirectConfigState,
}));

vi.mock("../../lib/runtime/codexConversationController", () => ({
  getCodexConversationController: () => codexControllerMock,
  useCodexConversationSnapshot: () => codexConversationState,
}));

vi.mock("../../lib/runtime/codexProjectManager", () => ({
  getCodexProjectManager: () => codexProjectManagerMock,
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
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({} as CanvasRenderingContext2D));
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
    responsesDirectConfigState = {
      authMethod: "api_key",
      apiKey: "sk-test",
    };
    currentDocUriState = null;
    bridgeSnapshot = {
      state: "idle",
      url: null,
      lastError: null,
    };
    setThreadIdMock = vi.fn(async () => {});
    fetchUpdatesMock = vi.fn(async () => {});
    useChatKitMock.mockReset();
    useChatKitMock.mockReturnValue({
      control: {},
      setThreadId: setThreadIdMock,
      fetchUpdates: fetchUpdatesMock,
    });
    harnessManagerMock.setDefault.mockClear();
    bridgeMock.connect.mockImplementation(async () => {});
    bridgeMock.connect.mockClear();
    bridgeMock.disconnect.mockClear();
    bridgeMock.setHandler.mockClear();
    bridgeMock.subscribe.mockClear();
    bridgeMock.getSnapshot.mockClear();
    proxyMock.useTransport.mockClear();
    proxyMock.connectProxy.mockClear();
    proxyMock.connectWasm.mockClear();
    proxyMock.disconnect.mockClear();
    proxyMock.setCodeExecutor.mockClear();
    proxyMock.setAuthorizationResolver.mockClear();
    codexControllerMock.setSelectedProject.mockClear();
    codexControllerMock.refreshHistory.mockClear();
    codexControllerMock.newChat.mockClear();
    codexControllerMock.setSelectedModel.mockClear();
    codexControllerMock.getSnapshot.mockClear();
    codexControllerMock.getThread.mockClear();
    codexControllerMock.listItems.mockClear();
    codexControllerMock.streamUserMessage.mockClear();
    codexControllerMock.interruptActiveTurn.mockClear();
    codexControllerMock.selectThread.mockClear();
    codexProjectManagerMock.setDefault.mockClear();
    appLoggerMock.info.mockClear();
    appLoggerMock.error.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("routes ChatKit to responses-direct and does not connect codex bridge", async () => {
    const { rerender } = render(<ChatKitPanel />);
    await waitForChatKitToRerender();

    const config = getLatestChatKitConfig();
    expect(config.api.url).toBe("http://127.0.0.1:31337/responses/direct/chatkit");
    expect(bridgeMock.connect).not.toHaveBeenCalled();
    expect(bridgeMock.disconnect).not.toHaveBeenCalled();
  });

  it("renders a harness selector and switches the default harness", async () => {
    const { rerender } = render(<ChatKitPanel />);

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
    await waitForChatKitToRerender();

    const config = getLatestChatKitConfig();
    expect(config.api.url).toBe("http://127.0.0.1:31337/responses/direct/chatkit");

    await act(async () => {
      const response = await config.api.fetch(
        "http://127.0.0.1:31337/responses/direct/chatkit",
        {
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
        },
      );
      await response.text();
    });

    expect(bridgeMock.connect).not.toHaveBeenCalled();
  });

  it("routes ChatKit to codex-wasm adapter URL and initializes the wasm app-server client", async () => {
    harnessState.defaultHarness.adapter = "codex-wasm";

    const { rerender } = render(<ChatKitPanel />);
    await waitFor(() => expect(proxyMock.connectWasm).toHaveBeenCalled());

    const config = getLatestChatKitConfig();
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
              content: [{ type: "input_text", text: "hello" }],
            },
          },
        }),
      });
    });

    expect(codexControllerMock.streamUserMessage).toHaveBeenCalled();
    await waitFor(() => expect(proxyMock.useTransport).toHaveBeenCalledWith("wasm"));
    expect(proxyMock.setCodeExecutor).toHaveBeenCalledWith(expect.any(Function));
    await waitFor(() =>
      expect(proxyMock.connectWasm).toHaveBeenCalledWith({
        apiKey: "sk-test",
        sessionOptions: expect.objectContaining({
          instructions: expect.objectContaining({
            developer: expect.stringContaining(
              "Executed JavaScript runs inside the Runme AppKernel runtime.",
            ),
          }),
        }),
      }),
    );
    expect(bridgeMock.connect).not.toHaveBeenCalled();
  });

  it("renders an app-owned model picker with gpt-5.4", () => {
    render(<ChatKitPanel />);

    const modelSelect = screen.getByTestId(
      "chat-shell-model-select",
    ) as HTMLSelectElement;
    expect(
      [...modelSelect.options].map((option) => option.value),
    ).toEqual(expect.arrayContaining(["gpt-5.4"]));
  });

  it("routes ChatKit to /codex/app-server/ws and connects codex bridge + proxy websocket", async () => {
    harnessState.defaultHarness.adapter = "codex";

    render(<ChatKitPanel />);
    await waitFor(() => expect(proxyMock.connectProxy).toHaveBeenCalled());

    const config = getLatestChatKitConfig();
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
    expect(config.header.enabled).toBe(false);
    expect(screen.getByTestId("chat-shell-title").textContent).toBe("Runme Repo");
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

  it("does not reconnect codex proxy transport when only the responses-direct API key changes", async () => {
    harnessState.defaultHarness.adapter = "codex";

    const { rerender } = render(<ChatKitPanel />);

    await waitFor(() =>
      expect(proxyMock.connectProxy).toHaveBeenCalledWith(
        "ws://127.0.0.1:31337/codex/app-server/ws",
        "Bearer test-id-token",
      ),
    );

    proxyMock.connectProxy.mockClear();
    proxyMock.disconnect.mockClear();

    responsesDirectConfigState = {
      ...responsesDirectConfigState,
      apiKey: "sk-updated",
    };
    rerender(<ChatKitPanel />);

    await waitFor(() => {
      expect(proxyMock.connectProxy).not.toHaveBeenCalled();
      expect(proxyMock.disconnect).not.toHaveBeenCalled();
    });
  });

  it("does not restart codex runtime when the active notebook changes", async () => {
    harnessState.defaultHarness.adapter = "codex";

    const { rerender } = render(<ChatKitPanel />);

    await waitFor(() =>
      expect(proxyMock.connectProxy).toHaveBeenCalledWith(
        "ws://127.0.0.1:31337/codex/app-server/ws",
        "Bearer test-id-token",
      ),
    );

    proxyMock.connectProxy.mockClear();
    proxyMock.disconnect.mockClear();
    bridgeMock.connect.mockClear();
    bridgeMock.disconnect.mockClear();

    currentDocUriState = "file:///tmp/other.notebook.md";
    rerender(<ChatKitPanel />);

    await waitFor(() => {
      expect(proxyMock.connectProxy).not.toHaveBeenCalled();
      expect(proxyMock.disconnect).not.toHaveBeenCalled();
      expect(bridgeMock.connect).not.toHaveBeenCalled();
      expect(bridgeMock.disconnect).not.toHaveBeenCalled();
    });
  });

  it("hydrates an existing codex thread on load and passes it to ChatKit as initialThread", async () => {
    harnessState.defaultHarness.adapter = "codex";
    codexConversationState.currentThreadId = "thread-bootstrap";

    render(<ChatKitPanel />);

    expect(getLatestChatKitConfig().initialThread).toBe("thread-bootstrap");
    await waitFor(() =>
      expect(setThreadIdMock).toHaveBeenCalledWith("thread-bootstrap"),
    );
  });

  it("routes codex prompt requests through the codex conversation controller", async () => {
    harnessState.defaultHarness.adapter = "codex";

    render(<ChatKitPanel />);

    const config = getLatestChatKitConfig();

    await act(async () => {
      const response = await config.api.fetch("http://127.0.0.1:31337/codex/chatkit", {
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

    expect(codexControllerMock.streamUserMessage).toHaveBeenCalledWith(
      "print('hello')",
      expect.any(Object),
      "gpt-5.2",
      null,
    );
  });

  it("switches chatkit endpoint immediately when harness default changes", async () => {
    const { rerender } = render(<ChatKitPanel />);
    await waitForChatKitToRerender();

    expect(getLatestChatKitConfig().api.url).toBe(
      "http://127.0.0.1:31337/responses/direct/chatkit",
    );

    harnessState.defaultHarness = {
      ...harnessState.defaultHarness,
      adapter: "codex",
    };
    rerender(<ChatKitPanel />);

    expect(getLatestChatKitConfig().api.url).toBe(
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

    expect(getLatestChatKitConfig().api.url).toBe(
      "http://127.0.0.1:31337/responses/direct/chatkit",
    );
    expect(bridgeMock.disconnect).toHaveBeenCalled();
    expect(proxyMock.disconnect).toHaveBeenCalled();
  });

  it("renders the codex project drawer and conversation list", async () => {
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

    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-shell-history-button"));
    });

    expect(screen.getByTestId("conversation-drawer")).toBeTruthy();
    expect(screen.getByTestId("codex-project-select")).toBeTruthy();
    expect(
      screen.getByTestId("codex-thread-thread-1").textContent ?? "",
    ).toContain("Investigate latency");
  });

  it("closes the conversation drawer from its close button", async () => {
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

    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-shell-history-button"));
    });

    expect(screen.getByTestId("conversation-drawer")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId("conversation-drawer-close"));
    });

    expect(screen.queryByTestId("conversation-drawer")).toBeNull();
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

    const { rerender } = render(<ChatKitPanel />);
    await waitFor(() => expect(proxyMock.connectProxy).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-shell-history-button"));
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("codex-thread-thread-1"));
    });

    expect(codexControllerMock.selectThread).toHaveBeenCalledWith("thread-1");
    expect(setThreadIdMock).toHaveBeenCalledWith("thread-1");
    expect(fetchUpdatesMock).toHaveBeenCalled();
  });

  it("surfaces response.failed SSE events as an in-panel error", async () => {
    harnessState.defaultHarness.adapter = "codex";
    codexControllerMock.streamUserMessage.mockImplementationOnce(
      async (_input: string, sink: { emit: (payload: unknown) => void }) => {
        sink.emit({
          type: "response.failed",
          error: { message: "Timed out waiting for codex turn completion" },
        });
      },
    );

    render(<ChatKitPanel />);

    const config = getLatestChatKitConfig();

    await act(async () => {
      const response = await config.api.fetch("http://127.0.0.1:31337/codex/chatkit", {
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
      await response.text();
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

  it("logs codex timing milestones from submit through first streamed text", async () => {
    harnessState.defaultHarness.adapter = "codex";
    codexControllerMock.streamUserMessage.mockImplementationOnce(
      async (_input: string, sink: { emit: (payload: unknown) => void }) => {
        sink.emit({ type: "response.created", response: { id: "turn-timing-1" } });
        sink.emit({
          type: "response.output_text.delta",
          response_id: "turn-timing-1",
          item_id: "msg-timing-1",
          delta: "I’m checking the codebase now.",
        });
        sink.emit({
          type: "response.completed",
          response: { id: "turn-timing-1" },
        });
      },
    );

    render(<ChatKitPanel />);

    const config = getLatestChatKitConfig();
    act(() => {
      config.onLog({
        name: "composer.submit",
        data: {
          text: [
            {
              type: "input_text",
              text: "Search the codebase and explain the Jupyter integration",
            },
          ],
        },
      });
    });

    await act(async () => {
      const response = await config.api.fetch("http://127.0.0.1:31337/codex/chatkit", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "threads.create",
          params: {
            input: {
              content: [
                {
                  type: "input_text",
                  text: "Search the codebase and explain the Jupyter integration",
                },
              ],
            },
          },
        }),
      });
      await response.text();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(appLoggerMock.info).toHaveBeenCalledWith(
      "ChatKit timing",
      expect.objectContaining({
        attrs: expect.objectContaining({
          scope: "chatkit.panel",
          adapter: "codex",
          phase: "submit",
          promptChars: 55,
        }),
      }),
    );
    expect(appLoggerMock.info).toHaveBeenCalledWith(
      "ChatKit timing",
      expect.objectContaining({
        attrs: expect.objectContaining({
          scope: "chatkit.panel",
          adapter: "codex",
          phase: "response_created",
          responseId: "turn-timing-1",
        }),
      }),
    );
    expect(appLoggerMock.info).toHaveBeenCalledWith(
      "ChatKit timing",
      expect.objectContaining({
        attrs: expect.objectContaining({
          scope: "chatkit.panel",
          adapter: "codex",
          phase: "first_visible_message",
          responseId: "turn-timing-1",
          eventType: "response.output_text.delta",
          preview: "I’m checking the codebase now.",
        }),
      }),
    );
    expect(appLoggerMock.info).toHaveBeenCalledWith(
      "ChatKit timing",
      expect.objectContaining({
        attrs: expect.objectContaining({
          scope: "chatkit.panel",
          adapter: "codex",
          phase: "completed",
          responseId: "turn-timing-1",
          sawFirstVisibleMessage: true,
        }),
      }),
    );
    expect(appLoggerMock.info).toHaveBeenCalledWith(
      "ChatKit visible stream event",
      expect.objectContaining({
        attrs: expect.objectContaining({
          scope: "chatkit.panel",
          adapter: "codex",
          responseId: "turn-timing-1",
          eventType: "response.output_text.delta",
          textChars: 30,
          preview: "I’m checking the codebase now.",
        }),
      }),
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

    const { rerender } = render(<ChatKitPanel />);
    await waitFor(() => expect(proxyMock.connectProxy).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-shell-history-button"));
    });

    await act(async () => {
      fireEvent.change(screen.getByTestId("codex-project-select"), {
        target: { value: "project-2" },
      });
    });
    codexProjectsState = {
      ...codexProjectsState,
      defaultProject: { id: "project-2", name: "Docs Repo" },
    };
    codexConversationState = {
      ...codexConversationState,
      selectedProject: { id: "project-2", name: "Docs Repo" },
    };
    rerender(<ChatKitPanel />);
    await waitFor(() => expect(codexControllerMock.setSelectedProject).toHaveBeenCalledWith("project-2"));

    expect(codexControllerMock.refreshHistory).toHaveBeenCalled();
    expect(setThreadIdMock).toHaveBeenCalledWith(null);
  });

  it("logs chatkit errors through appLogger", async () => {
    render(<ChatKitPanel />);
    await waitForChatKitToRerender();

    const config = getLatestChatKitConfig();

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

  it("logs chatkit thread changes through appLogger", async () => {
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
    await waitFor(() => expect(proxyMock.connectProxy).toHaveBeenCalled());

    const config = getLatestChatKitConfig();
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
          codexCurrentThreadId: null,
          codexCurrentTurnId: null,
        }),
      }),
    );
  });

  it("ignores null chatkit thread changes when codex already has an active thread", async () => {
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
    await waitFor(() => expect(proxyMock.connectProxy).toHaveBeenCalled());

    const config = getLatestChatKitConfig();
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

  it("ignores null chatkit thread changes when the controller thread advances before rerender", async () => {
    harnessState.defaultHarness.adapter = "codex";
    codexConversationState.currentThreadId = null;
    codexConversationState.currentTurnId = null;

    render(<ChatKitPanel />);
    await waitFor(() => expect(proxyMock.connectProxy).toHaveBeenCalled());

    const config = getLatestChatKitConfig();

    codexConversationState = {
      ...codexConversationState,
      currentThreadId: "thread-race",
      currentTurnId: "turn-race",
    };

    act(() => {
      config.onThreadChange({ threadId: null });
    });

    expect(codexControllerMock.newChat).not.toHaveBeenCalled();
    expect(appLoggerMock.info).toHaveBeenCalledWith(
      "Ignoring null ChatKit thread change while Codex thread is active",
      expect.objectContaining({
        attrs: expect.objectContaining({
          scope: "chatkit.panel",
          adapter: "codex",
          threadId: null,
          codexCurrentThreadId: "thread-race",
          codexCurrentTurnId: "turn-race",
        }),
      }),
    );
  });
});
