import { useEffect } from "react";

import { appLogger } from "../../lib/logging/runtime";
import {
  buildExecuteCodeInputSchema,
  EXECUTE_CODE_TOOL_DESCRIPTION,
  EXECUTE_CODE_TOOL_NAME,
  EXECUTE_CODE_TOOL_TITLE,
} from "../../lib/runtime/executeCodeTool";
import { useCodeModeExecutor } from "../../lib/runtime/useCodeModeExecutor";

type ModelContextClientLike = {
  requestUserInteraction?: (callback: () => Promise<unknown> | unknown) => Promise<unknown>;
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
      execute: (input: { code?: unknown }, client: ModelContextClientLike) => Promise<string>;
    },
    options?: { signal?: AbortSignal },
  ) => void;
};

function getModelContext(): ModelContextLike | null {
  if (typeof navigator === "undefined") {
    return null;
  }
  const modelContext = (navigator as Navigator & {
    modelContext?: Partial<ModelContextLike>;
  }).modelContext;
  if (!modelContext || typeof modelContext.registerTool !== "function") {
    return null;
  }
  return modelContext as ModelContextLike;
}

export default function WebMcpToolRegistrationHost() {
  const codeModeExecutor = useCodeModeExecutor({ mode: "sandbox" });

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
              typeof input?.code === "string" ? input.code : String(input?.code ?? "");
            const result = await codeModeExecutor.execute({
              code,
              source: "webmcp",
            });
            return result.output;
          },
        },
        {
          signal: registrationController.signal,
        },
      );
      appLogger.info("WebMCP ExecuteCode tool registered", {
        attrs: {
          scope: "webmcp",
          toolName: EXECUTE_CODE_TOOL_NAME,
        },
      });
    } catch (error) {
      appLogger.error("Failed to register WebMCP tool", {
        attrs: {
          scope: "webmcp",
          toolName: EXECUTE_CODE_TOOL_NAME,
          error: String(error),
        },
      });
      return;
    }

    return () => {
      registrationController.abort();
      appLogger.info("WebMCP ExecuteCode tool unregistered", {
        attrs: {
          scope: "webmcp",
          toolName: EXECUTE_CODE_TOOL_NAME,
        },
      });
    };
  }, [codeModeExecutor]);

  return null;
}
