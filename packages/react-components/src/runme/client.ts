import * as parser_pb from '@buf/stateful_runme.bufbuild_es/runme/parser/v1/parser_pb'
import * as runner_pb from '@buf/stateful_runme.bufbuild_es/runme/runner/v2/runner_pb'
import { DescService } from '@bufbuild/protobuf'
import { createClient } from '@connectrpc/connect'
import { createGrpcWebTransport } from '@connectrpc/connect-web'

import { getSessionToken } from '../token'

export function createConnectClient<T extends DescService>(
  service: T,
  baseURL: string
) {
  const transport = createGrpcWebTransport({
    baseUrl: baseURL,
    interceptors: [
      (next) => (req) => {
        const token = getSessionToken()
        if (token) {
          req.header.set('Authorization', `Bearer ${token}`)
        }
        return next(req).catch((e) => {
          throw e // allow caller to handle the error
        })
      },
    ],
  })
  return createClient(service, transport)
}

export type RunnerClient = ReturnType<
  typeof createClient<typeof runner_pb.RunnerService>
>
export type ParserClient = ReturnType<
  typeof createClient<typeof parser_pb.ParserService>
>

export enum MimeType {
  StatefulRunmeOutputItems = 'stateful.runme/output-items',
  StatefulRunmeTerminal = 'stateful.runme/terminal',
  VSCodeNotebookStdOut = 'application/vnd.code.notebook.stdout',
  VSCodeNotebookStdErr = 'application/vnd.code.notebook.stderr',
}

const privatePrefix = 'runme.dev/'

export enum RunmeMetadataKey {
  ID = 'id',
  RunmeID = `${privatePrefix}id`,
  LastRunID = `${privatePrefix}lastRunID`,
  Pid = `${privatePrefix}pid`,
  ExitCode = `${privatePrefix}exitCode`,
}

export enum AgentMetadataKey {
  PreviousResponseId = `${privatePrefix}previousResponseId`,
}

export { parser_pb, runner_pb }
