// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createResponsesDirectChatkitFetch } from "./responsesDirectChatKitAdapter";
import { __resetResponsesDirectConfigManagerForTests } from "./responsesDirectConfigManager";

vi.mock("../../token", () => ({
  getAccessToken: vi.fn(async () => "oauth-test-token"),
}));

function sseResponse(payloads: Array<Record<string, unknown>>): Response {
  const encoded = payloads.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(encoded, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
    },
  });
}

describe("responsesDirectChatKitAdapter", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    localStorage.removeItem("runme/responses-direct-config");
    __resetResponsesDirectConfigManagerForTests();
    const { responsesDirectConfigManager } = await import("./responsesDirectConfigManager");
    responsesDirectConfigManager.setAuthMethod("oauth");
    responsesDirectConfigManager.setOpenAIOrganization("org-test");
    responsesDirectConfigManager.setOpenAIProject("proj-test");
    responsesDirectConfigManager.setVectorStores(["vs_1"]);
  });

  it("maps a threads.create request into OpenAI Responses streaming events", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        sseResponse([
          { type: "response.created", response: { id: "resp-1" } },
          {
            type: "response.output_item.added",
            item: { id: "msg-assistant-1", type: "message" },
          },
          {
            type: "response.output_text.delta",
            item_id: "msg-assistant-1",
            delta: "print('hello world')",
          },
          {
            type: "response.output_item.done",
            item: {
              id: "msg-assistant-1",
              type: "message",
              content: [{ type: "output_text", text: "print('hello world')" }],
            },
          },
          { type: "response.completed", response: { id: "resp-1" } },
        ]),
      );

    const fetchFn = createResponsesDirectChatkitFetch();
    const response = await fetchFn("/responses/direct/chatkit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "threads.create",
        params: {
          input: {
            content: [{ type: "input_text", text: "print hello world in python" }],
            attachments: [],
            inference_options: { model: "gpt-5.2" },
          },
        },
      }),
    });

    const body = await response.text();
    expect(body).toContain('"type":"thread.created"');
    expect(body).toContain('"type":"thread.item.added"');
    expect(body).toContain('"type":"thread.item.updated"');
    expect(body).toContain("print('hello world')");
    expect(body).toContain('"type":"thread.item.done"');

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
      }),
    );
    const headers = fetchMock.mock.calls.at(0)?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer oauth-test-token");
    expect(headers.get("OpenAI-Organization")).toBe("org-test");
    expect(headers.get("OpenAI-Project")).toBe("proj-test");
  });

  it("uses API key auth when configured", async () => {
    const { responsesDirectConfigManager } = await import("./responsesDirectConfigManager");
    responsesDirectConfigManager.setAuthMethod("api_key");
    responsesDirectConfigManager.setAPIKey("sk-api-key");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      sseResponse([
        { type: "response.created", response: { id: "resp-2" } },
        { type: "response.completed", response: { id: "resp-2" } },
      ]),
    );

    const fetchFn = createResponsesDirectChatkitFetch();
    const response = await fetchFn("/responses/direct/chatkit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "threads.create",
        params: {
          input: {
            content: [{ type: "input_text", text: "hello" }],
            attachments: [],
            inference_options: {},
          },
        },
      }),
    });

    await response.text();
    const headers = fetchMock.mock.calls.at(0)?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer sk-api-key");
    expect(headers.get("OpenAI-Organization")).toBeNull();
    expect(headers.get("OpenAI-Project")).toBeNull();
  });

  it("uses explicit responses baseUrl override", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      sseResponse([
        { type: "response.created", response: { id: "resp-3" } },
        { type: "response.completed", response: { id: "resp-3" } },
      ]),
    );

    const fetchFn = createResponsesDirectChatkitFetch({
      responsesApiBaseUrl: "http://127.0.0.1:19989",
    });
    const response = await fetchFn("/responses/direct/chatkit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "threads.create",
        params: {
          input: {
            content: [{ type: "input_text", text: "hello override" }],
            attachments: [],
            inference_options: {},
          },
        },
      }),
    });

    await response.text();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:19989/v1/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
      }),
    );
  });

  it("includes ExecuteCode function tool in Responses request payload", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      sseResponse([
        { type: "response.created", response: { id: "resp-tools" } },
        { type: "response.completed", response: { id: "resp-tools" } },
      ]),
    );

    const fetchFn = createResponsesDirectChatkitFetch();
    const response = await fetchFn("/responses/direct/chatkit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "threads.create",
        params: {
          input: {
            content: [{ type: "input_text", text: "run code" }],
            attachments: [],
            inference_options: { model: "gpt-5.2" },
          },
        },
      }),
    });

    await response.text();

    const requestInit = fetchMock.mock.calls.at(0)?.[1];
    const requestBody = JSON.parse(String(requestInit?.body ?? "{}")) as {
      tools?: Array<Record<string, unknown>>;
      instructions?: string;
    };
    const executeCodeTool = (requestBody.tools ?? []).find(
      (tool) =>
        tool?.type === "function" &&
        tool?.name === "ExecuteCode",
    ) as Record<string, unknown> | undefined;

    expect(executeCodeTool).toBeDefined();
    expect(executeCodeTool?.strict).toBe(true);
    expect(executeCodeTool?.parameters).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        code: { type: "string" },
      },
      required: ["code"],
    });
    expect(requestBody.instructions).toContain("single tool: ExecuteCode");
    expect(requestBody.instructions).toContain("embedded in the Runme app ChatKit panel");
    expect(requestBody.instructions).toContain("agent harnesses");
    expect(requestBody.instructions).toContain(
      "https://drive.google.com/drive/folders/1Qdg_VA4ZBlOKojJqW2CqSVuJ2p2I4yS5",
    );
    expect(requestBody.instructions).toContain("console.log(explorer.mountDrive(");
    expect(requestBody.instructions).toContain("call notebooks.get({ handle: result.handle }) to verify the new cell exists");
    expect(requestBody.instructions).toContain('report the new cell refId');
    expect(requestBody.instructions).toContain(
      "tell the user to click Run on that cell manually",
    );
    expect(requestBody.instructions).toContain('"runme.dev/runnerName": "appkernel-js"');
    expect(requestBody.instructions).toContain("await help()");
    expect(requestBody.instructions).toContain("notebooks.help");
    expect(requestBody.instructions).toContain("Always await helper calls");
    expect(requestBody.instructions).toContain("doc.notebook.cells");
    expect(requestBody.instructions).toContain("new TextDecoder().decode(item.data)");
    expect(requestBody.instructions).toContain('op="insert"');
    expect(requestBody.instructions).toContain('Do not use JSON Patch style mutations');
  });

  it("executes ExecuteCode internally and continues the Responses turn", async () => {
    const codeModeExecutor = {
      execute: vi.fn(async () => ({ output: "tool output" })),
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
      sseResponse([
        { type: "response.created", response: { id: "resp-prev" } },
        {
          type: "response.function_call_arguments.done",
          item_id: "tool-item-1",
          call_id: "call-1",
          name: "ExecuteCode",
          arguments: "{\"code\":\"console.log('hi')\"}",
        },
        { type: "response.completed", response: { id: "resp-prev" } },
      ]),
    )
      .mockResolvedValueOnce(
        sseResponse([
          { type: "response.created", response: { id: "resp-final" } },
          {
            type: "response.output_item.added",
            item: { id: "msg-assistant-2", type: "message" },
          },
          {
            type: "response.output_text.delta",
            item_id: "msg-assistant-2",
            delta: "done",
          },
          {
            type: "response.output_item.done",
            item: {
              id: "msg-assistant-2",
              type: "message",
              content: [{ type: "output_text", text: "done" }],
            },
          },
          { type: "response.completed", response: { id: "resp-final" } },
        ]),
      );

    const fetchFn = createResponsesDirectChatkitFetch({ codeModeExecutor });
    const response = await fetchFn("/responses/direct/chatkit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "threads.create",
        params: {
          input: {
            content: [{ type: "input_text", text: "run code" }],
            attachments: [],
            inference_options: { model: "gpt-5.2" },
          },
        },
      }),
    });

    const body = await response.text();
    expect(body).not.toContain("\"type\":\"client_tool_call\"");
    expect(body).toContain("\"delta\":\"done\"");
    expect(codeModeExecutor.execute).toHaveBeenCalledWith({
      code: "console.log('hi')",
      source: "chatkit",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondRequestBody = JSON.parse(
      String(fetchMock.mock.calls.at(1)?.[1]?.body ?? "{}"),
    ) as {
      previous_response_id?: string;
      input?: Array<Record<string, unknown>>;
    };
    expect(secondRequestBody.previous_response_id).toBe("resp-prev");
    expect(secondRequestBody.input?.[0]).toEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: "tool output",
    });
  });

  it("falls back call_id to item_id only when item_id already looks like a call id", async () => {
    const codeModeExecutor = {
      execute: vi.fn(async () => ({ output: "ok" })),
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
      sseResponse([
        { type: "response.created", response: { id: "resp-prev" } },
        {
          type: "response.function_call_arguments.done",
          item_id: "call_fallback_from_item_id",
          name: "ExecuteCode",
          arguments: "{\"code\":\"console.log('hi')\"}",
        },
        { type: "response.completed", response: { id: "resp-prev" } },
      ]),
    )
      .mockResolvedValueOnce(
        sseResponse([
          { type: "response.created", response: { id: "resp-final" } },
          { type: "response.completed", response: { id: "resp-final" } },
        ]),
      );

    const fetchFn = createResponsesDirectChatkitFetch({ codeModeExecutor });
    const response = await fetchFn("/responses/direct/chatkit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "threads.create",
        params: {
          input: {
            content: [{ type: "input_text", text: "run code" }],
            attachments: [],
            inference_options: { model: "gpt-5.2" },
          },
        },
      }),
    });

    await response.text();
    const secondRequestBody = JSON.parse(
      String(fetchMock.mock.calls.at(1)?.[1]?.body ?? "{}"),
    ) as {
      input?: Array<Record<string, unknown>>;
    };
    expect(secondRequestBody.input?.[0]?.call_id).toBe(
      "call_fallback_from_item_id",
    );
  });

  it("recovers call_id from function_call output item when arguments.done omits call_id", async () => {
    const codeModeExecutor = {
      execute: vi.fn(async () => ({ output: "ok" })),
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
      sseResponse([
        { type: "response.created", response: { id: "resp-prev" } },
        {
          type: "response.output_item.added",
          item: {
            id: "fc_abc123",
            type: "function_call",
            name: "ExecuteCode",
            call_id: "call_84MJLvWD9WwoH8CO9DPT2CNy",
          },
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "fc_abc123",
          arguments: "{\"code\":\"console.log('hi')\"}",
        },
        { type: "response.completed", response: { id: "resp-prev" } },
      ]),
    )
      .mockResolvedValueOnce(
        sseResponse([
          { type: "response.created", response: { id: "resp-final" } },
          { type: "response.completed", response: { id: "resp-final" } },
        ]),
      );

    const fetchFn = createResponsesDirectChatkitFetch({ codeModeExecutor });
    const response = await fetchFn("/responses/direct/chatkit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "threads.create",
        params: {
          input: {
            content: [{ type: "input_text", text: "run code" }],
            attachments: [],
            inference_options: { model: "gpt-5.2" },
          },
        },
      }),
    });

    await response.text();
    const requestInit = fetchMock.mock.calls.at(1)?.[1];
    const requestBody = JSON.parse(String(requestInit?.body ?? "{}")) as {
      instructions?: string;
      input?: Array<Record<string, unknown>>;
    };
    expect(requestBody.instructions).toContain("single tool: ExecuteCode");
    expect(requestBody.instructions).toContain("Always await helper calls");
    expect(requestBody.input?.[0]?.type).toBe("function_call_output");
    expect(requestBody.input?.[0]?.call_id).toBe("call_84MJLvWD9WwoH8CO9DPT2CNy");
    expect(requestBody.input?.[0]?.call_id).not.toBe("fc_abc123");
  });

  it("preserves partial tool output when internal execution fails", async () => {
    const error = new Error("ExecuteCode timed out after 20ms") as Error & {
      output?: string;
    };
    error.output = "started\npartial stderr";
    const codeModeExecutor = {
      execute: vi.fn(async () => {
        throw error;
      }),
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        sseResponse([
          { type: "response.created", response: { id: "resp-tool-error" } },
          {
            type: "response.function_call_arguments.done",
            item_id: "tool-item-1",
            call_id: "call-1",
            name: "ExecuteCode",
            arguments: "{\"code\":\"console.log('hi')\"}",
          },
          { type: "response.completed", response: { id: "resp-tool-error" } },
        ]),
      )
      .mockResolvedValueOnce(
        sseResponse([
          { type: "response.created", response: { id: "resp-tool-error-2" } },
          { type: "response.completed", response: { id: "resp-tool-error-2" } },
        ]),
      );

    const fetchFn = createResponsesDirectChatkitFetch({ codeModeExecutor });
    const response = await fetchFn("/responses/direct/chatkit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "threads.create",
        params: {
          input: {
            content: [{ type: "input_text", text: "run code" }],
            attachments: [],
            inference_options: { model: "gpt-5.2" },
          },
        },
      }),
    });

    await response.text();
    const requestInit = fetchMock.mock.calls.at(1)?.[1];
    const requestBody = JSON.parse(String(requestInit?.body ?? "{}")) as {
      input?: Array<Record<string, unknown>>;
    };
    expect(requestBody.input?.[0]?.output).toContain("started");
    expect(requestBody.input?.[0]?.output).toContain("partial stderr");
    expect(requestBody.input?.[0]?.output).toContain(
      "Tool execution failed: Error: ExecuteCode timed out after 20ms",
    );
  });
});
