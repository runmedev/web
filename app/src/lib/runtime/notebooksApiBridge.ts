import {
  type NotebookDataLike,
  type NotebookQuery,
  type NotebookTarget,
  type NotebooksApi,
  createNotebooksApi,
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
  return {
    handleMessage: async ({ method, args = [] }) => {
      switch (method) {
        case 'notebooks.help':
          return notebooksApi.help(args[0] as any)
        case 'notebooks.list':
          return notebooksApi.list((args[0] as NotebookQuery | undefined) ?? undefined)
        case 'notebooks.get':
          return notebooksApi.get((args[0] as NotebookTarget | undefined) ?? undefined)
        case 'notebooks.update':
          return notebooksApi.update(
            (args[0] as Parameters<NotebooksApi['update']>[0] | undefined) ?? {
              operations: [],
            }
          )
        case 'notebooks.delete':
          return notebooksApi.delete(args[0] as NotebookTarget)
        case 'notebooks.execute':
          return notebooksApi.execute(
            (args[0] as Parameters<NotebooksApi['execute']>[0] | undefined) ?? {
              refIds: [],
            }
          )
        default:
          throw new Error(`Unsupported sandbox NotebooksApi method: ${method}`)
      }
    },
  }
}
