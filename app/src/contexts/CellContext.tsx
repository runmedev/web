import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import { clone, create } from "@bufbuild/protobuf";

import {
  AgentMetadataKey,
  MimeType,
  RunmeMetadataKey,
  parser_pb,
} from "../runme/client";
import { ChatkitStateSchema } from "../protogen/oaiproto/aisre/notebooks_pb";

// TODO(jlewi): Rename this to ChatkitContext. It no longer stores CellContext data; just chatkit state.

export type CellContextType = {
  getChatkitState: () => ReturnType<typeof createChatkitState>;
  setChatkitState: (state: ReturnType<typeof createChatkitState>) => void;
};

const CellContext = createContext<CellContextType | undefined>(undefined);

// eslint-disable-next-line react-refresh/only-export-components
export const useCell = () => {
  const context = useContext(CellContext);
  if (!context) {
    throw new Error("useCell must be used within a CellProvider");
  }
  return context;
};

function createChatkitState() {
  return create(ChatkitStateSchema, {
    previousResponseId: "",
    threadId: "",
  });
}

export interface CellProviderProps {
  children: ReactNode;
}

export const CellProvider = ({ children }: CellProviderProps) => {
  const [chatkitState, setChatkitStateState] = useState(createChatkitState());

  const getChatkitState = useCallback(() => {
    return clone(ChatkitStateSchema, chatkitState);
  }, [chatkitState]);

  const setChatkitState = useCallback(
    (nextState: ReturnType<typeof createChatkitState>) => {
      setChatkitStateState(clone(ChatkitStateSchema, nextState));
    },
    [],
  );

  const contextValue = useMemo<CellContextType>(
    () => ({
      getChatkitState,
      setChatkitState,
    }),
    [getChatkitState, setChatkitState],
  );

  return (
    <CellContext.Provider value={contextValue}>{children}</CellContext.Provider>
  );
};

// singleton text encoder for non-streaming output
const textEncoder = new TextEncoder();

// eslint-disable-next-line react-refresh/only-export-components
export function createCellOutputs(
  {
    pid,
    exitCode,
  }: {
    pid: number | null;
    exitCode: number | null;
  },
  stdout: string,
  stderr: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _mimeType: string | null, // todo(sebastian): Runme's serializer ignores text/plain
): parser_pb.CellOutput[] {
  let processInfo: parser_pb.CellOutputProcessInfo | undefined;

  if (pid !== null && exitCode !== null) {
    processInfo = create(parser_pb.CellOutputProcessInfoSchema, {
      pid: BigInt(pid),
      exitReason: create(parser_pb.ProcessInfoExitReasonSchema, {
        type: "exit",
        code: exitCode,
      }),
    });
  }

  return [
    create(parser_pb.CellOutputSchema, {
      items: [
        create(parser_pb.CellOutputItemSchema, {
          mime: MimeType.VSCodeNotebookStdOut,
          type: "Buffer",
          data: textEncoder.encode(stdout),
        }),
        create(parser_pb.CellOutputItemSchema, {
          mime: MimeType.VSCodeNotebookStdErr,
          type: "Buffer",
          data: textEncoder.encode(stderr),
        }),
      ],
      processInfo,
    }),
  ];
}

const TypingCell = create(parser_pb.CellSchema, {
  kind: parser_pb.CellKind.MARKUP,
  role: parser_pb.CellRole.ASSISTANT,
  value: "...",
});

// eslint-disable-next-line react-refresh/only-export-components
export { parser_pb, TypingCell, MimeType, RunmeMetadataKey, AgentMetadataKey };
