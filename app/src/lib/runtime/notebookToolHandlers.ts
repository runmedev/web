import { create, fromJsonString, toJson } from "@bufbuild/protobuf";
import { type Cell } from "../../protogen/runme/parser/v1/parser_pb.js";
import {
  GetCellsResponseSchema,
  ListCellsResponseSchema,
  NotebookServiceExecuteCellsResponseSchema,
  ToolCallInputSchema,
  ToolCallOutputSchema,
  ToolCallOutput_Status,
  UpdateCellsResponseSchema,
} from "../../protogen/oaiproto/aisre/notebooks_pb.js";
import type { CodeModeExecutor } from "./codeModeExecutor";
import { getCodeModeErrorOutput } from "./codeModeExecutor";

export const TOOL_PREFIX = "agent_tools_v1_NotebookService_";
export const UPDATE_CELLS_TOOL = TOOL_PREFIX + "UpdateCells";
export const LIST_CELLS_TOOL = TOOL_PREFIX + "ListCells";
export const GET_CELLS_TOOL = TOOL_PREFIX + "GetCells";
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
  getLatestCells: () => Cell[];
  updateCell: (cell: Cell) => void;
  executeCellsWithApproval?: (
    bridgeCallId: string,
    refIds: string[],
  ) => Promise<Cell[]>;
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

    const toolOutput = create(ToolCallOutputSchema, {
      callId: decodedInput.callId,
      previousResponseId: decodedInput.previousResponseId,
      status: ToolCallOutput_Status.SUCCESS,
      clientError: "",
    });
    const latestCells = options.getLatestCells();
    const cellMap = new Map<string, Cell>();
    latestCells.forEach((cell) => {
      cellMap.set(cell.refId, cell);
    });

    const inputCase = String(decodedInput.input?.case ?? "");
    switch (inputCase) {
      case "updateCells": {
        const cells = decodedInput.input.value?.cells ?? [];
        if (cells.length === 0) {
          toolOutput.status = ToolCallOutput_Status.FAILED;
          toolOutput.clientError = "UpdateCells invoked without cells payload";
          break;
        }
        cells.forEach((updatedCell: Cell) => options.updateCell(updatedCell));
        toolOutput.output = {
          case: "updateCells",
          value: create(UpdateCellsResponseSchema, { cells }),
        };
        break;
      }
      case "listCells": {
        toolOutput.output = {
          case: "listCells",
          value: create(ListCellsResponseSchema, { cells: latestCells }),
        };
        break;
      }
      case "getCells": {
        const requestedRefs = decodedInput.input.value?.refIds ?? [];
        const foundCells = requestedRefs
          .map((id: string) => cellMap.get(id))
          .filter((cell): cell is Cell => Boolean(cell));
        toolOutput.output = {
          case: "getCells",
          value: create(GetCellsResponseSchema, { cells: foundCells }),
        };
        break;
      }
      case "executeCells": {
        if (!options.executeCellsWithApproval) {
          toolOutput.status = ToolCallOutput_Status.FAILED;
          toolOutput.clientError = "ExecuteCells is not configured";
          break;
        }
        try {
          const executedCells = await options.executeCellsWithApproval(
            bridgeCallId,
            decodedInput.input.value?.refIds ?? [],
          );
          toolOutput.output = {
            case: "executeCells",
            value: create(NotebookServiceExecuteCellsResponseSchema, {
              cells: executedCells,
            }),
          };
        } catch (error) {
          toolOutput.status = ToolCallOutput_Status.FAILED;
          toolOutput.clientError = String(error);
        }
        break;
      }
      case "executeCode": {
        const code = decodedInput.input.value?.code ?? "";
        try {
          const result = await options.codeModeExecutor.execute({
            code,
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
      }
      default: {
        toolOutput.status = ToolCallOutput_Status.FAILED;
        toolOutput.clientError = `Unsupported codex notebook tool input: ${String(inputCase)}`;
        break;
      }
    }
    return toJson(ToolCallOutputSchema, toolOutput) as Record<string, unknown>;
  };
}

export function createChatKitNotebookToolInvoker(
  options: NotebookToolHandlerOptions,
): (invocation: {
  name: string;
  params?: unknown;
}) => Promise<Record<string, unknown>> {
  return async (invocation) => {
    const toolOutput = create(ToolCallOutputSchema, {
      callId: "",
      previousResponseId: "",
      status: ToolCallOutput_Status.SUCCESS,
      clientError: "",
    });

    switch (invocation.name) {
      case EXECUTE_CODE_DIRECT_TOOL:
      case EXECUTE_CODE_TOOL: {
        const executeCodePayload = parseExecuteCodePayload(invocation.params);
        if (!executeCodePayload) {
          toolOutput.status = ToolCallOutput_Status.FAILED;
          toolOutput.clientError =
            "ExecuteCode tool invoked without valid code payload";
          return toJson(ToolCallOutputSchema, toolOutput) as Record<
            string,
            unknown
          >;
        }
        if (!executeCodePayload.callId) {
          toolOutput.status = ToolCallOutput_Status.FAILED;
          toolOutput.clientError =
            "ExecuteCode is missing call_id in tool params";
          return toJson(ToolCallOutputSchema, toolOutput) as Record<
            string,
            unknown
          >;
        }

        const callId = executeCodePayload.callId;
        const previousResponseId = executeCodePayload.previousResponseId;
        try {
          const result = await options.codeModeExecutor.execute({
            code: executeCodePayload.code,
            source: "chatkit",
          });
          if (invocation.name === EXECUTE_CODE_DIRECT_TOOL) {
            return {
              callId,
              previousResponseId,
              output: result.output,
            };
          }
          return buildExecuteCodeToolOutput({
            callId,
            previousResponseId,
            output: result.output,
          });
        } catch (error) {
          if (invocation.name === EXECUTE_CODE_DIRECT_TOOL) {
            return {
              callId,
              previousResponseId,
              output: getCodeModeErrorOutput(error),
              clientError: String(error),
            };
          }
          return buildExecuteCodeToolOutput({
            callId,
            previousResponseId,
            output: getCodeModeErrorOutput(error),
            clientError: String(error),
          });
        }
      }
      case UPDATE_CELLS_TOOL:
      case GET_CELLS_TOOL:
      case LIST_CELLS_TOOL:
        break;
      default: {
        toolOutput.status = ToolCallOutput_Status.FAILED;
        toolOutput.clientError = `Unknown tool ${invocation.name}`;
        return toJson(ToolCallOutputSchema, toolOutput) as Record<
          string,
          unknown
        >;
      }
    }

    let decodedInput;
    try {
      const payload =
        typeof invocation.params === "string"
          ? invocation.params
          : JSON.stringify(invocation.params ?? {});
      decodedInput = fromJsonString(ToolCallInputSchema, payload);
    } catch (error) {
      toolOutput.status = ToolCallOutput_Status.FAILED;
      toolOutput.clientError = `Failed to decode tool params: ${error}`;
      return {
        success: false,
        result: toJson(ToolCallOutputSchema, toolOutput),
      } as Record<string, unknown>;
    }

    toolOutput.callId = decodedInput.callId;
    toolOutput.previousResponseId = decodedInput.previousResponseId;

    const inputCase = String(decodedInput.input?.case ?? "");
    const cellMap = new Map<string, Cell>();
    options.getLatestCells().forEach((cell) => {
      cellMap.set(cell.refId, cell);
    });

    switch (invocation.name) {
      case UPDATE_CELLS_TOOL: {
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
          toolOutput.clientError = "UpdateCells invoked without cells payload";
        }

        cells.forEach((updatedCell: Cell) => {
          if (!updatedCell?.refId) {
            return;
          }
          options.updateCell(updatedCell);
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
          .map((id: string) => cellMap.get(id))
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
        toolOutput.output = {
          case: "listCells",
          value: create(ListCellsResponseSchema, {
            cells: options.getLatestCells(),
          }),
        };
        break;
      }
      default: {
        toolOutput.status = ToolCallOutput_Status.FAILED;
        toolOutput.clientError = `Unknown tool ${invocation.name}`;
        return toJson(ToolCallOutputSchema, toolOutput) as Record<
          string,
          unknown
        >;
      }
    }

    return toJson(ToolCallOutputSchema, toolOutput) as Record<string, unknown>;
  };
}
