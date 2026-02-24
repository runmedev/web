// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

type HarnessAdapter = "responses" | "codex";

let harnessState: { defaultHarness: { name: string; baseUrl: string; adapter: HarnessAdapter } };
let bridgeSnapshot: { state: "idle" | "connecting" | "open" | "closed" | "error"; url: string | null; lastError: string | null };
let bridgeListener: (() => void) | null;
const useChatKitMock = vi.fn();
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
    getChatkitState: () => ({}),
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

vi.mock("../../lib/runtime/harnessManager", async () => {
  const actual = await vi.importActual<typeof import("../../lib/runtime/harnessManager")>(
    "../../lib/runtime/harnessManager"
  );
  return {
    ...actual,
    useHarness: () => harnessState,
  };
});

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
    bridgeSnapshot = {
      state: "idle",
      url: null,
      lastError: null,
    };
    bridgeListener = null;
    useChatKitMock.mockReset();
    useChatKitMock.mockReturnValue({ control: {} });
    bridgeMock.connect.mockClear();
    bridgeMock.disconnect.mockClear();
    bridgeMock.setHandler.mockClear();
    bridgeMock.subscribe.mockClear();
    bridgeMock.getSnapshot.mockClear();
    approvalMgrMock.failAll.mockClear();
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

  it("routes ChatKit to /chatkit-codex and connects codex bridge websocket", () => {
    harnessState.defaultHarness.adapter = "codex";

    render(<ChatKitPanel />);

    const config = useChatKitMock.mock.calls.at(0)?.[0];
    expect(config.api.url).toBe("http://127.0.0.1:31337/chatkit-codex");
    expect(bridgeMock.connect).toHaveBeenCalledWith("ws://127.0.0.1:31337/codex/ws");
    expect(bridgeMock.setHandler).toHaveBeenCalled();
  });

  it("shows codex bridge error diagnostic banner and clears pending approvals on disconnect", () => {
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

    expect(screen.getByTestId("codex-bridge-error").textContent).toContain(
      "codex_ws_already_connected",
    );
    expect(approvalMgrMock.failAll).toHaveBeenCalledWith("Codex bridge disconnected");
  });

  it("switches chatkit endpoint immediately when harness default changes", () => {
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
      "http://127.0.0.1:31337/chatkit-codex",
    );
    expect(bridgeMock.connect).toHaveBeenCalledWith("ws://127.0.0.1:31337/codex/ws");

    harnessState.defaultHarness = {
      ...harnessState.defaultHarness,
      adapter: "responses",
    };
    rerender(<ChatKitPanel />);

    expect(useChatKitMock.mock.calls.at(-1)?.[0]?.api?.url).toBe(
      "http://127.0.0.1:31337/chatkit",
    );
    expect(bridgeMock.disconnect).toHaveBeenCalled();
  });
});
