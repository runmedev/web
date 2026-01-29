import { type DescService } from "@bufbuild/protobuf";
import { createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

import * as parser_pb from "@buf/stateful_runme.bufbuild_es/runme/parser/v1/parser_pb";
import * as runner_pb from "@buf/stateful_runme.bufbuild_es/runme/runner/v2/runner_pb";

// n.b. Codex added client.ts as part of moving CellContext.tsx into the monorepo.
// Not sure whether it makes sense to define our own client or use the one in the
// runme repo. Guess we'll try using ours for now.

export enum MimeType {
  StatefulRunmeOutputItems = "stateful.runme/output-items",
  StatefulRunmeTerminal = "stateful.runme/terminal",
  VSCodeNotebookStdOut = "application/vnd.code.notebook.stdout",
  VSCodeNotebookStdErr = "application/vnd.code.notebook.stderr",
}

export enum RunmeMetadataKey {
  ID = "id",
  RunmeID = "runme.dev/id",
  Sequence = "runme.dev/sequence",
  LastRunID = "runme.dev/lastRunID",
  Pid = "runme.dev/pid",
  ExitCode = "runme.dev/exitCode",
  RunnerName = "runme.dev/runnerName",
}

export enum AgentMetadataKey {
  PreviousResponseId = "runme.dev/previousResponseId",
}

export function createConnectClient<T extends DescService>(
  service: T,
  baseURL: string,
  interceptors: Interceptor[] = [],
) {
  const transport = createConnectTransport({
    baseUrl: baseURL,
    interceptors,
  });
  return createClient(service, transport);
}

export { parser_pb, runner_pb };
