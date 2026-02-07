import { useCallback, useEffect, useMemo, useState } from "react";
import { ChatKit, useChatKit, ChatKitIcon } from "@openai/chatkit-react";
import { parser_pb, useCell } from "../../contexts/CellContext";
import { useNotebookContext } from "../../contexts/NotebookContext";
import { useOutput } from "../../contexts/OutputContext";
import { useSettings } from "../../contexts/SettingsContext";
import { useCurrentDoc } from "../../contexts/CurrentDocContext";
import { create, fromJsonString, toJson } from "@bufbuild/protobuf";

import { getAccessToken, getAuthData } from "../../token";
import { getBrowserAdapter } from "../../browserAdapter.client";
import { type Cell } from "../../protogen/runme/parser/v1/parser_pb.js";
import {
  ToolCallInputSchema,
  ToolCallOutputSchema,
  ToolCallOutput_Status,
  UpdateCellsResponseSchema,
  GetCellsResponseSchema,
  ListCellsResponseSchema,
  ChatkitStateSchema,
} from "../../protogen/oaiproto/aisre/notebooks_pb.js";

class UserNotLoggedInError extends Error {
  constructor(message = "You must log in to use AISRE chat.") {
    super(message);
    this.name = "UserNotLoggedInError";
  }
}

const CHATKIT_DOMAIN_KEY = (() => {
  const envValue = import.meta.env.VITE_CHATKIT_DOMAIN_KEY;
  if (envValue) {
    return envValue;
  }
  if (
    typeof window !== "undefined" &&
    window.location.hostname === "localhost"
  ) {
    return "domain_pk_localhost_dev";
  }
  return "domain_pk_68f8054e7da081908cc1972e9167ec270895bf04413e753b";
})();

const CHATKIT_GREETING = "How can AISRE help you today?";

const CHATKIT_PLACEHOLDER =
  "Describe the production issue or question you are investigating";

const CHATKIT_STARTER_PROMPTS = [
  {
    label: "Setup a local runner for AISRE to execute code",
    prompt: "How do I setup a local runner to execute code with the AISRE?",
    icon: "circle-question",
  },
  {
    label: "Plot metrics",
    prompt: "Plot the requests for the o3 model.",
    icon: "book-open",
  },
  {
    label: "Handle an alert or incident",
    prompt:
      "I just got paged for TBT (time between tokens) being high. Search notion, the mono-repo, and slack for runbooks for dealing with this alert and give me instrunctions for dealing with it?",
    icon: "search",
  },
] as const;

const TOOL_PREFIX = "agent_tools_v1_NotebookService_";

const UPDATE_CELLS_TOOL = TOOL_PREFIX + "UpdateCells";
const LIST_CELLS_TOOL = TOOL_PREFIX + "ListCells";
const GET_CELLS_TOOL = TOOL_PREFIX + "GetCells";

type SSEInterceptor = (rawEvent: string) => void;

const useAuthorizedFetch = (
  getChatkitState: () => ReturnType<(typeof ChatkitStateSchema)["create"]>,
  options?: { onSSEEvent?: SSEInterceptor },
) => {
  const { onSSEEvent } = options ?? {};
  return useMemo(() => {
    const authorizedFetch: typeof fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      try {
        const authData = await getAuthData();
        const idToken = authData?.idToken ?? undefined;
        const oaiAccessToken = await getAccessToken();
        if (!oaiAccessToken) {          
          throw new UserNotLoggedInError();
        }

        const headers = new Headers(
          init?.headers ??
            (input instanceof Request ? input.headers : undefined),
        );

        if (idToken) {
          headers.set("Authorization", `Bearer ${idToken}`);
        }

        headers.set("OpenAIAccessToken", oaiAccessToken);

        let body = init?.body;
        const method =
          init?.method ?? (input instanceof Request ? input.method : "GET");
        if (method.toUpperCase() === "POST") {
          const state = getChatkitState();
          const chatkitStateJson = toJson(ChatkitStateSchema, state);
          if (body == null) {
            body = JSON.stringify({ chatkit_state: chatkitStateJson });
            headers.set("Content-Type", "application/json");
          } else {
            if (typeof body === "string") {
              try {
                const parsed = JSON.parse(body);
                parsed.chatkit_state = chatkitStateJson;
                body = JSON.stringify(parsed);
              } catch {
                const payload = new FormData();
                payload.append("payload", body);
                payload.append(
                  "chatkit_state",
                  JSON.stringify(chatkitStateJson),
                );
                body = payload;
              }
            } else if (body instanceof FormData) {
              body.set("chatkit_state", JSON.stringify(chatkitStateJson));
            } else if (body instanceof URLSearchParams) {
              body.set("chatkit_state", JSON.stringify(chatkitStateJson));
            } else if (body instanceof Blob || body instanceof ArrayBuffer) {
              const payload = new FormData();
              payload.append("payload", new Blob([body]));
              payload.append("chatkit_state", JSON.stringify(chatkitStateJson));
              body = payload;
            }
          }
        }

        const nextInit: RequestInit = {
          ...init,
          headers,
          body,
        };

        const response = await fetch(input, nextInit);
        //return response;
        const isSSE =
          onSSEEvent &&
          response.headers
            .get("content-type")
            ?.toLowerCase()
            .includes("text/event-stream") &&
          response.body;

        if (!isSSE || !response.body) {
          return response;
        }

        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        const reader = response.body.getReader();
        let buffer = "";

        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const { done, value } = await reader.read();
            if (done) {
              const tail = decoder.decode();
              if (tail) {
                buffer += tail;
              }
              if (buffer.length > 0) {
                try {
                  onSSEEvent?.(buffer);
                } catch (eventError) {
                  console.error("SSE interceptor error", eventError);
                }
                controller.enqueue(encoder.encode(buffer));
              }
              controller.close();
              return;
            }

            if (value) {
              buffer += decoder.decode(value, { stream: true });
              let boundary;
              while ((boundary = buffer.indexOf("\n\n")) !== -1) {
                const rawEvent = buffer.slice(0, boundary + 2);
                buffer = buffer.slice(boundary + 2);
                try {
                  onSSEEvent?.(rawEvent);
                } catch (eventError) {
                  console.error("SSE interceptor error", eventError);
                }
                controller.enqueue(encoder.encode(rawEvent));
              }
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } catch (cancelError) {
              console.error("Failed to cancel SSE reader", cancelError);
            }
          },
        });

        const interceptedResponse = new Response(stream, {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers(response.headers),
        });

        return interceptedResponse;
      } catch (error) {
        console.error("ChatKit authorized fetch failed", error);
        throw error;
      }
    };

    return authorizedFetch;
  }, [onSSEEvent, getChatkitState]);
};

function ChatKitPanel() {
  const [showLoginPrompt, setShowLoginPrompt] = useState(false);
  const { settings } = useSettings();
  const { getChatkitState, setChatkitState } = useCell();
  const { getNotebookData, useNotebookSnapshot } = useNotebookContext();
  const { getCurrentDoc } = useCurrentDoc();
  const { getAllRenderers } = useOutput();
  const currentDocUri = getCurrentDoc();
  const notebookSnapshot = useNotebookSnapshot(currentDocUri ?? "");
  const orderedCells = useMemo(
    () => notebookSnapshot?.notebook.cells ?? [],
    [notebookSnapshot],
  );
  const updateCell = useCallback(
    (cell: Cell) => {
      if (!cell?.refId || !currentDocUri) {
        return;
      }
      const data = getNotebookData(currentDocUri);
      if (!data) {
        return;
      }
      for (const renderer of getAllRenderers().values()) {
        renderer.onCellUpdate(cell as unknown as parser_pb.Cell);
      }
      data.updateCell(cell as unknown as parser_pb.Cell);
    },
    [currentDocUri, getAllRenderers, getNotebookData],
  );
  const handleSseEvent = useCallback(
    (rawEvent: string) => {
      const lines = rawEvent
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      for (const line of lines) {
        if (!line.startsWith("data:")) {
          continue;
        }
        const payload = line.slice("data:".length).trim();
        if (!payload) {
          continue;
        }

        try {
          const parsed = JSON.parse(payload);
          if (parsed?.type !== "aisre.chatkit.state") {
            continue;
          }

          const item = parsed?.item ?? parsed?.Item;
          if (!item) {
            continue;
          }

          const stateData = item.state ?? item.State ?? item;
          if (!stateData) {
            continue;
          }

          const state = fromJsonString(
            ChatkitStateSchema,
            JSON.stringify(stateData),
          );
          setChatkitState(state);
          if (state.previousResponseId || state.threadId) {
            console.log(
              "ChatKit state update",
              JSON.stringify(
                {
                  previous_response_id: state.previousResponseId,
                  thread_id: state.threadId,
                },
                null,
                2,
              ),
            );
          }
        } catch (error) {
          console.error("Failed to parse SSE state event", error, payload);
        }
      }
    },
    [setChatkitState],
  );
  const authorizedFetch = useAuthorizedFetch(getChatkitState, {
    onSSEEvent: handleSseEvent,
  });

  const chatkitApiUrl = useMemo(() => {
    const base = settings.agentEndpoint ?? "";
    try {
      const url = new URL(base);
      url.pathname = "/chatkit";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return `${base.replace(/\/$/, "")}/chatkit`;
    }
  }, [settings.agentEndpoint]);
  const chatkit = useChatKit({
    api: {
      url: chatkitApiUrl,
      domainKey: CHATKIT_DOMAIN_KEY,
      fetch: authorizedFetch,
    },
    theme: {
      colorScheme: "light",
      radius: "round",
    },
    startScreen: {
      greeting: CHATKIT_GREETING,
      prompts: CHATKIT_STARTER_PROMPTS,
    },
    // see: https://openai.github.io/chatkit-js/api/openai/chatkit/type-aliases/composeroption/#tools
    composer: {
      placeholder: CHATKIT_PLACEHOLDER,
      models: [
        {
          id: "gpt-4o-mini",
          label: "GPT-4o Mini",
        },
        {
          id: "gpt-5",
          label: "GPT-5",
        },
        // gpt-5.2 appears to be about 2x as slow as gpt-4.1-mini-2025-04-14
        // but for a simple query that's 2s vs 1s so not a huge difference
        // This is still 10x faster than gpt 5 which took about 10x and felt like
        // molasses.
        {
          id: "gpt-5.2",
          label: "GPT-5.2",
          default: true,
        },
        {
          id: "gpt-5-mini",
          label: "GPT-5 Mini",          
        },
        {
          id: "gpt-5-nano",
          label: "GPT-5 Nano",
        },
      ],
      // TODO(jlewi): We want to make the company knowledge tool optional but on by default.
      // Unfortunately if we make it a tool it is not on by default and there doesn't seem to be a way to
      // select it programmatically.
      // tools: [
      //   {
      //     icon: "search" as ChatKitIcon,
      //     id: "company-knowledge",
      //     label: "Search Company Knowledge",
      //     persistent: true,
      //     pinned: true,
      //   },
      // ],
    },
    header: {
      enabled: true,
    },
    history: {
      enabled: true,
    },
    onClientTool: async (invocation) => {
      const toolOutput = create(ToolCallOutputSchema, {
        callId: "",
        previousResponseId: "",
        status: ToolCallOutput_Status.SUCCESS,
        clientError: "",
      });

      let decodedInput;
      try {
        const payload =
          typeof invocation.params === "string"
            ? invocation.params
            : JSON.stringify(invocation.params ?? {});
        decodedInput = fromJsonString(ToolCallInputSchema, payload);
      } catch (error) {
        console.error("Failed to decode tool params", error, invocation.params);
        toolOutput.status = ToolCallOutput_Status.FAILED;
        toolOutput.clientError = `Failed to decode tool params: ${error}`;
        return {
          success: false,
          result: toJson(ToolCallOutputSchema, toolOutput),
        };
      }

      toolOutput.callId = decodedInput.callId;
      toolOutput.previousResponseId = decodedInput.previousResponseId;

      const inputCase = decodedInput.input?.case;
      const cellMap = new Map<string, Cell>();
      orderedCells.forEach((cell) => {
        cellMap.set(cell.refId, cell);
      });

      switch (invocation.name) {
        case UPDATE_CELLS_TOOL: {
          console.log(`[ChatKit tool] ${invocation.name}`, decodedInput);
          if (inputCase !== "updateCells") {
            toolOutput.status = ToolCallOutput_Status.FAILED;
            toolOutput.clientError =
              "UpdateCells tool invoked without updateCells payload";
            break;
          }

          const updateCellsRequest = decodedInput.input.value;
          if (!updateCellsRequest) {
            toolOutput.status = ToolCallOutput_Status.FAILED;
            toolOutput.clientError = "UpdateCells request missing payload";
            break;
          }

          const cells: Cell[] = updateCellsRequest.cells ?? [];
          if (cells.length === 0) {
            toolOutput.status = ToolCallOutput_Status.FAILED;
            toolOutput.clientError =
              "UpdateCells invoked without cells payload";
          }

          cells.forEach((updatedCell: Cell) => {
            try {
              if (!updatedCell?.refId) {
                console.warn("Received cell without refId", updatedCell);
                return;
              }

              updateCell(updatedCell);
            } catch (error) {
              console.error(
                "Failed to process UpdateCell payload",
                error,
                updatedCell,
              );
              toolOutput.status = ToolCallOutput_Status.FAILED;
              toolOutput.clientError = `Failed to process UpdateCell payload: ${error}`;
            }
          });

          toolOutput.output = {
            case: "updateCells",
            value: create(UpdateCellsResponseSchema, {
              cells,
            }),
          };
          break;
        }
        case GET_CELLS_TOOL: {
          console.log(`[ChatKit tool] ${invocation.name}`, decodedInput);
          if (inputCase !== "getCells") {
            toolOutput.status = ToolCallOutput_Status.FAILED;
            toolOutput.clientError =
              "GetCells tool invoked without getCells payload";
            break;
          }

          const getCellsRequest = decodedInput.input.value;
          if (!getCellsRequest) {
            toolOutput.status = ToolCallOutput_Status.FAILED;
            toolOutput.clientError = "GetCells request missing payload";
            break;
          }

          const requestedRefs = getCellsRequest.refIds ?? [];
          const foundCells = requestedRefs
            .map((id) => {
              const cell = cellMap.get(id);
              if (!cell) {
                console.warn(`Requested cell ${id} not found`);
              }
              return cell;
            })
            .filter((cell): cell is Cell => Boolean(cell));

          toolOutput.output = {
            case: "getCells",
            value: create(GetCellsResponseSchema, {
              cells: foundCells,
            }),
          };
          break;
        }
        case LIST_CELLS_TOOL: {
          console.log(`[ChatKit tool] ${invocation.name}`, decodedInput);
          toolOutput.output = {
            case: "listCells",
            value: create(ListCellsResponseSchema, {
              cells: orderedCells,
            }),
          };
          break;
        }
        default: {
          toolOutput.status = ToolCallOutput_Status.FAILED;
          toolOutput.clientError = `Unknown tool ${invocation.name}`;
          return toJson(ToolCallOutputSchema, toolOutput);
        }
      }

      return toJson(ToolCallOutputSchema, toolOutput);
    },
    onError: ({ error }) => {
      const promptForLogin = () => setShowLoginPrompt(true);

      // This is a bit of a hacky way to check for authentication errors.
      // Chatkit throws a StreamError if the user isn't logged in. 
      void (async () => {
        const token = await getAccessToken();
        if (!token) {
          promptForLogin();
        }
      })();

      console.error("ChatKit error", error);
    },
  });

  const handleLogin = useCallback(() => {
    setShowLoginPrompt(false);
    getBrowserAdapter().loginWithRedirect();
  }, []);

  const handleDismissPrompt = useCallback(() => {
    setShowLoginPrompt(false);
  }, []);

  return (
    <div className="relative h-full w-full">
      <ChatKit control={chatkit.control} className="block h-full w-full" />
      {showLoginPrompt ? (
        <div className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center bg-white/90 p-4 text-sm">
          <div className="w-full max-w-sm rounded-nb-md border border-nb-cell-border bg-white p-4 shadow-nb-lg">
            <p className="mb-4 text-nb-text">
              Please log in to use AISRE chat features.
            </p>
            <div className="flex justify-end gap-2">              
              <button
                type="button"
                className="rounded border border-nb-text px-3 py-1 text-nb-text hover:bg-nb-surface-2"
                onClick={handleLogin}
              >
                Log In
              </button>
              <button
                type="button"
                className="rounded border border-nb-cell-border px-3 py-1 text-nb-text-muted hover:bg-nb-surface-2"
                onClick={handleDismissPrompt}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default ChatKitPanel;
