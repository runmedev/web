// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createResponsesDirectChatkitFetch } from "./responsesDirectChatkitFetch";
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

describe("responsesDirectChatkitFetch", () => {
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
    expect(body).toContain('"type":"aisre.chatkit.state"');

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

  it("uses non-default harness origin as explicit responses endpoint override", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      sseResponse([
        { type: "response.created", response: { id: "resp-3" } },
        { type: "response.completed", response: { id: "resp-3" } },
      ]),
    );

    const fetchFn = createResponsesDirectChatkitFetch();
    const response = await fetchFn("http://127.0.0.1:19989/responses/direct/chatkit", {
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
});
