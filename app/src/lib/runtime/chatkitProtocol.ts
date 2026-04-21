// Source of truth for the custom ChatKit backend wire contract:
// https://github.com/openai/chatkit-python/blob/8e2d2577080112e21b4912b659bddf6ad967bfa4/chatkit/types.py
//
// These local TypeScript types intentionally model the subset of the Python SDK
// protocol that our Codex adapter emits and consumes. When behavior diverges,
// align this file to the Python definitions first and then update the adapter
// and tests to match.
export type ChatKitOutputTextPart = {
  type: "output_text";
  text: string;
  annotations?: Array<Record<string, unknown>>;
};

export type ChatKitInputTextPart = {
  type: "input_text";
  text: string;
  id?: string;
  data?: Record<string, unknown>;
  interactive?: boolean;
};

export type ChatKitAssistantMessageItem = {
  id: string;
  type: "assistant_message";
  status: "in_progress" | "completed";
  thread_id?: string;
  created_at?: string;
  content: ChatKitOutputTextPart[];
};

export type ChatKitUserMessageItem = {
  id: string;
  type: "user_message";
  thread_id?: string;
  created_at?: string;
  content: ChatKitInputTextPart[];
  attachments: Array<{
    id?: string;
    name?: string;
    mime_type?: string;
    size?: number;
  }>;
  quoted_text?: string;
  inference_options: {
    model?: string;
    tool_choice?: {
      id: string;
    };
  };
};

export type ChatKitEndOfTurnItem = {
  id: string;
  type: "end_of_turn";
  thread_id?: string;
  created_at?: string;
};

export type ChatKitMessageItem = {
  id: string;
  type: "message";
  role: "assistant" | "user";
  status: "in_progress" | "completed";
  content: ChatKitOutputTextPart[];
};

export type ChatKitResponseCreatedEvent = {
  type: "response.created";
  response: { id: string };
};

export type ChatKitResponseOutputItemAddedEvent = {
  type: "response.output_item.added";
  response_id: string;
  output_index: number;
  item: ChatKitMessageItem;
};

export type ChatKitResponseContentPartAddedEvent = {
  type: "response.content_part.added";
  response_id: string;
  output_index: number;
  item_id: string;
  content_index: number;
  part: ChatKitOutputTextPart;
};

export type ChatKitResponseOutputTextDeltaEvent = {
  type: "response.output_text.delta";
  response_id: string;
  output_index: number;
  item_id: string;
  content_index: number;
  delta: string;
};

export type ChatKitResponseOutputTextDoneEvent = {
  type: "response.output_text.done";
  response_id: string;
  output_index: number;
  item_id: string;
  content_index: number;
  text: string;
};

export type ChatKitResponseContentPartDoneEvent = {
  type: "response.content_part.done";
  response_id: string;
  output_index: number;
  item_id: string;
  content_index: number;
  part: ChatKitOutputTextPart;
};

export type ChatKitResponseOutputItemDoneEvent = {
  type: "response.output_item.done";
  response_id: string;
  output_index: number;
  item: ChatKitMessageItem;
};

export type ChatKitThreadCreatedEvent = {
  type: "thread.created";
  thread: {
    id: string;
    title: string;
    created_at: string;
  };
};

export type ChatKitResponseCompletedEvent = {
  type: "response.completed";
  response: { id: string };
};

export type ChatKitResponseFailedEvent = {
  type: "response.failed";
  error: { message: string };
};

export type ChatKitThreadItemAddedEvent = {
  type: "thread.item.added";
  item: ChatKitAssistantMessageItem | ChatKitUserMessageItem;
};

export type ChatKitAssistantMessageContentPartAdded = {
  type: "assistant_message.content_part.added";
  content_index: number;
  content: {
    type: "output_text";
    text: string;
    annotations: Array<Record<string, unknown>>;
  };
};

export type ChatKitAssistantMessageContentPartTextDelta = {
  type: "assistant_message.content_part.text_delta";
  content_index: number;
  delta: string;
};

export type ChatKitAssistantMessageContentPartDone = {
  type: "assistant_message.content_part.done";
  content_index: number;
  content: {
    type: "output_text";
    text: string;
    annotations: Array<Record<string, unknown>>;
  };
};

export type ChatKitThreadItemUpdatedEvent = {
  type: "thread.item.updated";
  item_id: string;
  update:
    | ChatKitAssistantMessageContentPartAdded
    | ChatKitAssistantMessageContentPartTextDelta
    | ChatKitAssistantMessageContentPartDone;
};

export type ChatKitThreadItemDoneEvent = {
  type: "thread.item.done";
  item: ChatKitAssistantMessageItem | ChatKitUserMessageItem | ChatKitEndOfTurnItem;
};

export type ChatKitStreamEvent =
  | ChatKitResponseCreatedEvent
  | ChatKitResponseOutputItemAddedEvent
  | ChatKitResponseContentPartAddedEvent
  | ChatKitResponseOutputTextDeltaEvent
  | ChatKitResponseOutputTextDoneEvent
  | ChatKitResponseContentPartDoneEvent
  | ChatKitResponseOutputItemDoneEvent
  | ChatKitThreadCreatedEvent
  | ChatKitResponseCompletedEvent
  | ChatKitResponseFailedEvent
  | ChatKitThreadItemAddedEvent
  | ChatKitThreadItemUpdatedEvent
  | ChatKitThreadItemDoneEvent;

export type ChatKitThreadCollection<T> = {
  data: T[];
  has_more: boolean;
};

export type ChatKitThreadSummary = {
  id: string;
  title: string;
  updated_at?: string;
};

export type ChatKitThreadDetail = {
  id: string;
  title: string;
  created_at: string;
  updated_at?: string;
  status: { type: string };
  metadata: Record<string, unknown>;
  items: ChatKitThreadCollection<unknown>;
  messages: ChatKitThreadCollection<unknown>;
};
