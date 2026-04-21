import type {
  ChatKitStreamEvent,
  ChatKitThreadDetail,
  ChatKitThreadSummary,
} from "./chatkitProtocol";
import type { HarnessProfile } from "./harnessManager";

export type HarnessChatKitThreadRequest = {
  signal?: AbortSignal | null;
};

export type HarnessChatKitMessageRequest = {
  threadId?: string;
  input: string;
  model?: string;
  createThread?: boolean;
  signal?: AbortSignal | null;
};

export type HarnessChatKitToolResultRequest = {
  threadId: string;
  callId: string;
  previousResponseId?: string;
  output: unknown;
  signal?: AbortSignal | null;
};

export type HarnessChatKitItem = unknown;

export type HarnessChatKitEventSink = {
  emit(event: ChatKitStreamEvent): void;
};

export type HarnessClientToolInvocation = {
  name: string;
  params?: unknown;
};

export interface HarnessChatKitAdapter {
  initialThreadId?: string;
  historyEnabled: boolean;
  onThreadSelected?: (threadId: string | null) => Promise<void>;
  onNewConversation?: () => Promise<string | null>;
  invokeClientTool?: (
    invocation: HarnessClientToolInvocation,
  ) => Promise<Record<string, unknown>>;
  listThreads(
    request?: HarnessChatKitThreadRequest,
  ): Promise<ChatKitThreadSummary[]>;
  getThread(
    threadId: string,
    request?: HarnessChatKitThreadRequest,
  ): Promise<ChatKitThreadDetail>;
  listItems(
    threadId: string,
    request?: HarnessChatKitThreadRequest,
  ): Promise<HarnessChatKitItem[]>;
  streamUserMessage(
    request: HarnessChatKitMessageRequest,
    sink: HarnessChatKitEventSink,
  ): Promise<void>;
  submitToolResult?(
    request: HarnessChatKitToolResultRequest,
    sink: HarnessChatKitEventSink,
  ): Promise<void>;
}

export interface HarnessRuntime {
  readonly profile: HarnessProfile;
  start(): Promise<void>;
  stop(): void;
  createChatKitAdapter(): HarnessChatKitAdapter;
}
