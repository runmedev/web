import { useEffect } from "react";

import { appLogger } from "../../lib/logging/runtime";
import { getAppConsoleData } from "../../lib/appConsole/appConsoleController";
import {
  buildReadInstructionsForAIAgentsInputSchema,
  readInstructionsForAIAgents,
  READ_INSTRUCTIONS_FOR_AI_AGENTS_TOOL_DESCRIPTION,
  READ_INSTRUCTIONS_FOR_AI_AGENTS_TOOL_NAME,
  READ_INSTRUCTIONS_FOR_AI_AGENTS_TOOL_TITLE,
} from "../../lib/runtime/aiAgentInstructions";
import {
  buildGetDocumentationInputSchema,
  buildListDocumentationInputSchema,
  getDocumentationForAgents,
  GET_DOCUMENTATION_TOOL_DESCRIPTION,
  GET_DOCUMENTATION_TOOL_NAME,
  GET_DOCUMENTATION_TOOL_TITLE,
  listDocumentationForAgents,
  LIST_DOCUMENTATION_TOOL_DESCRIPTION,
  LIST_DOCUMENTATION_TOOL_NAME,
  LIST_DOCUMENTATION_TOOL_TITLE,
} from "../../lib/runtime/documentationTools";
import {
  buildExecuteCodeInputSchema,
  EXECUTE_CODE_TOOL_DESCRIPTION,
  EXECUTE_CODE_TOOL_NAME,
  EXECUTE_CODE_TOOL_TITLE,
} from "../../lib/runtime/executeCodeTool";
import { useCodeModeExecutor } from "../../lib/runtime/useCodeModeExecutor";
import {
  buildDismissTourInputSchema,
  buildShowTourStepInputSchema,
  DISMISS_TOUR_TOOL_DESCRIPTION,
  DISMISS_TOUR_TOOL_NAME,
  DISMISS_TOUR_TOOL_TITLE,
  executeDismissTour,
  executeShowTourStep,
  SHOW_TOUR_STEP_TOOL_DESCRIPTION,
  SHOW_TOUR_STEP_TOOL_NAME,
  SHOW_TOUR_STEP_TOOL_TITLE,
} from "../../lib/runtime/tourGuideTool";

type ModelContextClientLike = {
  requestUserInteraction?: (
    callback: () => Promise<unknown> | unknown,
  ) => Promise<unknown>;
};

type ModelContextLike = {
  registerTool: (
    tool: {
      name: string;
      title: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations: {
        readOnlyHint: boolean;
        untrustedContentHint: boolean;
      };
      execute: (
        input: Record<string, unknown>,
        client: ModelContextClientLike,
      ) => Promise<string> | string;
    },
    options?: { signal?: AbortSignal },
  ) => void;
};

function getModelContext(): ModelContextLike | null {
  if (typeof navigator === "undefined") {
    return null;
  }
  const modelContext = (
    navigator as Navigator & {
      modelContext?: Partial<ModelContextLike>;
    }
  ).modelContext;
  if (!modelContext || typeof modelContext.registerTool !== "function") {
    return null;
  }
  return modelContext as ModelContextLike;
}

export default function WebMcpToolRegistrationHost() {
  const codeModeExecutor = useCodeModeExecutor({ mode: "sandbox" });
  const appConsoleData = getAppConsoleData();

  useEffect(() => {
    const modelContext = getModelContext();
    if (!modelContext) {
      appLogger.debug("WebMCP unavailable; skipping tool registration", {
        attrs: {
          scope: "webmcp",
        },
      });
      return;
    }

    const registrationController = new AbortController();

    try {
      modelContext.registerTool(
        {
          name: EXECUTE_CODE_TOOL_NAME,
          title: EXECUTE_CODE_TOOL_TITLE,
          description: EXECUTE_CODE_TOOL_DESCRIPTION,
          inputSchema: buildExecuteCodeInputSchema(),
          annotations: {
            readOnlyHint: false,
            untrustedContentHint: true,
          },
          execute: async (input) => {
            const code =
              typeof input?.code === "string"
                ? input.code
                : String(input?.code ?? "");
            const timeoutMs =
              typeof input?.timeoutMs === "number" &&
              Number.isFinite(input.timeoutMs)
                ? Math.min(60_000, Math.max(1_000, Math.trunc(input.timeoutMs)))
                : undefined;
            await appConsoleData.hydrate();

            const execution = appConsoleData.startExternalExecution(code);

            try {
              const result = await codeModeExecutor.execute({
                code,
                source: "webmcp",
                ...(timeoutMs ? { timeoutMs } : {}),
                hooks: execution
                  ? {
                      onStdout: (chunk) => {
                        appConsoleData.appendStdout(execution.cellId, chunk);
                      },
                      onStderr: (chunk) => {
                        appConsoleData.appendStderr(execution.cellId, chunk);
                      },
                    }
                  : undefined,
              });

              if (execution) {
                appConsoleData.completeExecution(execution.cellId, {
                  exitCode: result.exitCode,
                });
              }
              return result.output;
            } catch (error) {
              if (execution) {
                appConsoleData.failExecution(execution.cellId, {
                  message:
                    error instanceof Error ? error.message : String(error),
                });
              }
              throw error;
            }
          },
        },
        {
          signal: registrationController.signal,
        },
      );
      modelContext.registerTool(
        {
          name: READ_INSTRUCTIONS_FOR_AI_AGENTS_TOOL_NAME,
          title: READ_INSTRUCTIONS_FOR_AI_AGENTS_TOOL_TITLE,
          description: READ_INSTRUCTIONS_FOR_AI_AGENTS_TOOL_DESCRIPTION,
          inputSchema: buildReadInstructionsForAIAgentsInputSchema(),
          annotations: {
            readOnlyHint: true,
            untrustedContentHint: false,
          },
          execute: () => readInstructionsForAIAgents(window.location.origin),
        },
        {
          signal: registrationController.signal,
        },
      );
      modelContext.registerTool(
        {
          name: LIST_DOCUMENTATION_TOOL_NAME,
          title: LIST_DOCUMENTATION_TOOL_TITLE,
          description: LIST_DOCUMENTATION_TOOL_DESCRIPTION,
          inputSchema: buildListDocumentationInputSchema(),
          annotations: {
            readOnlyHint: true,
            untrustedContentHint: false,
          },
          execute: () => listDocumentationForAgents(),
        },
        {
          signal: registrationController.signal,
        },
      );
      modelContext.registerTool(
        {
          name: GET_DOCUMENTATION_TOOL_NAME,
          title: GET_DOCUMENTATION_TOOL_TITLE,
          description: GET_DOCUMENTATION_TOOL_DESCRIPTION,
          inputSchema: buildGetDocumentationInputSchema(),
          annotations: {
            readOnlyHint: true,
            untrustedContentHint: false,
          },
          execute: (input) =>
            getDocumentationForAgents(
              typeof input?.name === "string" ? input.name : "",
            ),
        },
        {
          signal: registrationController.signal,
        },
      );
      modelContext.registerTool(
        {
          name: SHOW_TOUR_STEP_TOOL_NAME,
          title: SHOW_TOUR_STEP_TOOL_TITLE,
          description: SHOW_TOUR_STEP_TOOL_DESCRIPTION,
          inputSchema: buildShowTourStepInputSchema(),
          annotations: {
            readOnlyHint: false,
            untrustedContentHint: false,
          },
          execute: (input) => executeShowTourStep(input),
        },
        {
          signal: registrationController.signal,
        },
      );
      modelContext.registerTool(
        {
          name: DISMISS_TOUR_TOOL_NAME,
          title: DISMISS_TOUR_TOOL_TITLE,
          description: DISMISS_TOUR_TOOL_DESCRIPTION,
          inputSchema: buildDismissTourInputSchema(),
          annotations: {
            readOnlyHint: false,
            untrustedContentHint: false,
          },
          execute: () => executeDismissTour(),
        },
        {
          signal: registrationController.signal,
        },
      );
      appLogger.info("WebMCP tools registered", {
        attrs: {
          scope: "webmcp",
          toolNames: [
            EXECUTE_CODE_TOOL_NAME,
            READ_INSTRUCTIONS_FOR_AI_AGENTS_TOOL_NAME,
            LIST_DOCUMENTATION_TOOL_NAME,
            GET_DOCUMENTATION_TOOL_NAME,
            SHOW_TOUR_STEP_TOOL_NAME,
            DISMISS_TOUR_TOOL_NAME,
          ],
        },
      });
    } catch (error) {
      registrationController.abort();
      appLogger.error("Failed to register WebMCP tool", {
        attrs: {
          scope: "webmcp",
          error: String(error),
        },
      });
      return;
    }

    return () => {
      registrationController.abort();
      appLogger.info("WebMCP tools unregistered", {
        attrs: {
          scope: "webmcp",
          toolNames: [
            EXECUTE_CODE_TOOL_NAME,
            READ_INSTRUCTIONS_FOR_AI_AGENTS_TOOL_NAME,
            LIST_DOCUMENTATION_TOOL_NAME,
            GET_DOCUMENTATION_TOOL_NAME,
            SHOW_TOUR_STEP_TOOL_NAME,
            DISMISS_TOUR_TOOL_NAME,
          ],
        },
      });
    };
  }, [appConsoleData, codeModeExecutor]);

  return null;
}
