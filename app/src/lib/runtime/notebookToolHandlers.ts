import { create, fromJsonString, toJson } from "@bufbuild/protobuf";
import {
  ToolCallInputSchema,
  ToolCallOutputSchema,
  ToolCallOutput_Status,
} from "../../protogen/oaiproto/aisre/notebooks_pb.js";
import type { CodeModeExecutor } from "./codeModeExecutor";
import { getCodeModeErrorOutput } from "./codeModeExecutor";

export const TOOL_PREFIX = "agent_tools_v1_NotebookService_";
export const EXECUTE_CODE_TOOL = TOOL_PREFIX + "ExecuteCode";
export const EXECUTE_CODE_DIRECT_TOOL = "ExecuteCode";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseExecuteCodePayload(value: unknown): {
  callId: string;
  previousResponseId: string;
  code: string;
} | null {
  if (typeof value === "string") {
    try {
      return parseExecuteCodePayload(JSON.parse(value));
    } catch {
      return null;
    }
  }
  const root = asRecord(value);
  const executeCodeCandidate = root.executeCode ?? root.execute_code ?? root;
  const executeCode = asRecord(executeCodeCandidate);
  const code = asString(executeCode.code);
  if (!code) {
    return null;
  }
  return {
    callId: asString(root.callId ?? root.call_id),
    previousResponseId: asString(
      root.previousResponseId ?? root.previous_response_id,
    ),
    code,
  };
}

export function buildExecuteCodeToolOutput(args: {
  callId: string;
  previousResponseId: string;
  output: string;
  clientError?: string;
}): Record<string, unknown> {
  const hasError = Boolean(
    args.clientError && args.clientError.trim().length > 0,
  );
  return {
    callId: args.callId,
    previousResponseId: args.previousResponseId,
    status: hasError ? "STATUS_FAILED" : "STATUS_SUCCESS",
    clientError: args.clientError ?? "",
    executeCode: {
      output: args.output,
    },
  };
}

type NotebookToolHandlerOptions = {
  codeModeExecutor: CodeModeExecutor;
};

export function createCodexBridgeToolHandler(
  options: NotebookToolHandlerOptions,
): (args: {
  bridgeCallId: string;
  toolCallInput: unknown;
}) => Promise<unknown> {
  return async ({ bridgeCallId, toolCallInput }) => {
    const rawExecuteCodePayload = parseExecuteCodePayload(toolCallInput);
    if (rawExecuteCodePayload) {
      const callId = rawExecuteCodePayload.callId || bridgeCallId;
      try {
        const result = await options.codeModeExecutor.execute({
          code: rawExecuteCodePayload.code,
          source: "codex",
        });
        return buildExecuteCodeToolOutput({
          callId,
          previousResponseId: rawExecuteCodePayload.previousResponseId,
          output: result.output,
        });
      } catch (error) {
        return buildExecuteCodeToolOutput({
          callId,
          previousResponseId: rawExecuteCodePayload.previousResponseId,
          output: getCodeModeErrorOutput(error),
          clientError: String(error),
        });
      }
    }

    let decodedInput;
    try {
      const payload =
        typeof toolCallInput === "string"
          ? toolCallInput
          : JSON.stringify(toolCallInput ?? {});
      decodedInput = fromJsonString(ToolCallInputSchema, payload);
    } catch (error) {
      const failedOutput = create(ToolCallOutputSchema, {
        status: ToolCallOutput_Status.FAILED,
        clientError: `Failed to decode tool params: ${error}`,
      });
      return toJson(ToolCallOutputSchema, failedOutput);
    }

    if (String(decodedInput.input?.case ?? "") !== "executeCode") {
      const failedOutput = create(ToolCallOutputSchema, {
        callId: decodedInput.callId,
        previousResponseId: decodedInput.previousResponseId,
        status: ToolCallOutput_Status.FAILED,
        clientError: `Unsupported codex notebook tool input: ${String(decodedInput.input?.case ?? "")}`,
      });
      return toJson(ToolCallOutputSchema, failedOutput);
    }

    try {
      const result = await options.codeModeExecutor.execute({
        code: decodedInput.input.value?.code ?? "",
        source: "codex",
      });
      return buildExecuteCodeToolOutput({
        callId: decodedInput.callId || bridgeCallId,
        previousResponseId: decodedInput.previousResponseId ?? "",
        output: result.output,
      });
    } catch (error) {
      return buildExecuteCodeToolOutput({
        callId: decodedInput.callId || bridgeCallId,
        previousResponseId: decodedInput.previousResponseId ?? "",
        output: getCodeModeErrorOutput(error),
        clientError: String(error),
      });
    }
  };
}
