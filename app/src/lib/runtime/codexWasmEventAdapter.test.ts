import { describe, expect, it } from "vitest";

import { adaptCodexWasmEvent } from "./codexWasmEventAdapter";

describe("adaptCodexWasmEvent", () => {
  it("passes through app-server notifications unchanged", () => {
    expect(
      adaptCodexWasmEvent(
        {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1" },
          },
        },
        {},
      ),
    ).toEqual([
      {
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1" },
        },
      },
    ]);
  });

  it("adapts raw core agent deltas to app-server notifications", () => {
    expect(
      adaptCodexWasmEvent(
        {
          type: "raw_core_event",
          event: {
            id: "turn-1",
            msg: {
              type: "agent_message_delta",
              delta: "hello ",
            },
          },
        },
        {
          threadId: "thread-1",
        },
      ),
    ).toEqual([
      {
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "turn-1-item",
          delta: "hello ",
        },
      },
    ]);
  });

  it("accepts the browser harness coreEvent envelope", () => {
    expect(
      adaptCodexWasmEvent(
        {
          type: "coreEvent",
          event: {
            id: "turn-1",
            msg: {
              type: "agent_message_delta",
              delta: "bonjour",
            },
          },
        },
        {
          threadId: "thread-1",
        },
      ),
    ).toEqual([
      {
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "turn-1-item",
          delta: "bonjour",
        },
      },
    ]);
  });

  it("adapts raw core turn completion into completed item and turn notifications", () => {
    expect(
      adaptCodexWasmEvent(
        {
          type: "raw_core_event",
          event: {
            id: "turn-1",
            msg: {
              type: "task_complete",
              turn_id: "turn-1",
              last_agent_message: "done",
            },
          },
        },
        {
          threadId: "thread-1",
        },
      ),
    ).toEqual([
      {
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "turn-1-item",
            text: "done",
          },
        },
      },
      {
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1" },
        },
      },
    ]);
  });
});
