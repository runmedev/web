import {
  type NotebookDataLike,
  type NotebookQuery,
  type NotebookTarget,
  type NotebooksApi,
  createNotebooksApi,
  makeJsonSafe,
} from './runmeConsole'

export type NotebooksApiBridgeRequest = {
  method: string
  args?: unknown[]
}

export type NotebooksApiBridgeServer = {
  handleMessage: (request: NotebooksApiBridgeRequest) => Promise<unknown>
}

export const SANDBOX_NOTEBOOKS_API_METHODS = [
  'notebooks.help',
  'notebooks.list',
  'notebooks.get',
  'notebooks.update',
  'notebooks.delete',
  'notebooks.execute',
] as const

export function createHostNotebooksApi({
  resolveNotebook,
  listNotebooks,
}: {
  resolveNotebook: (target?: unknown) => NotebookDataLike | null
  listNotebooks?: () => NotebookDataLike[]
}): NotebooksApi {
  return createNotebooksApi({
    resolveNotebook,
    listNotebooks,
  })
}

export function createNotebooksApiBridgeServer({
  notebooksApi,
}: {
  notebooksApi: NotebooksApi
}): NotebooksApiBridgeServer {
  const callJsonSafe = async (callback: () => Promise<unknown>) =>
    makeJsonSafe(await callback())

  return {
    handleMessage: async ({ method, args = [] }) => {
      switch (method) {
        case 'notebooks.help':
          return callJsonSafe(() => notebooksApi.help(args[0] as any))
        case 'notebooks.list':
          return callJsonSafe(() =>
            notebooksApi.list(
              (args[0] as NotebookQuery | undefined) ?? undefined
            )
          )
        case 'notebooks.get':
          return callJsonSafe(() =>
            notebooksApi.get(
              (args[0] as NotebookTarget | undefined) ?? undefined
            )
          )
        case 'notebooks.update':
          return callJsonSafe(() =>
            notebooksApi.update(
              (args[0] as
                | Parameters<NotebooksApi['update']>[0]
                | undefined) ?? {
                operations: [],
              }
            )
          )
        case 'notebooks.delete':
          return callJsonSafe(() =>
            notebooksApi.delete(args[0] as NotebookTarget)
          )
        case 'notebooks.execute':
          return callJsonSafe(() =>
            notebooksApi.execute(
              (args[0] as
                | Parameters<NotebooksApi['execute']>[0]
                | undefined) ?? {
                refIds: [],
              }
            )
          )
        default:
          throw new Error(`Unsupported sandbox NotebooksApi method: ${method}`)
      }
    },
  }
}
