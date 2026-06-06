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
  'notebooks.resolve',
  'notebooks.show',
  'notebooks.shareUrl',
  'notebooks.markdownLink',
  'notebooks.link',
] as const

type NotebookReferenceApi = {
  resolve?: (reference?: unknown) => Promise<unknown>
  show?: (reference?: unknown) => Promise<unknown>
  shareUrl?: (reference?: unknown) => Promise<string>
  markdownLink?: (reference?: unknown) => Promise<string>
  link?: (reference?: unknown) => Promise<string>
}

function requireReferenceMethod<T extends keyof Required<NotebookReferenceApi>>(
  notebooksApi: NotebooksApi,
  method: T
): Required<NotebookReferenceApi>[T] {
  const referenceApi = notebooksApi as NotebooksApi & NotebookReferenceApi
  const callback = referenceApi[method]
  if (typeof callback !== 'function') {
    throw new Error(
      `Unsupported sandbox NotebooksApi method: notebooks.${method}`
    )
  }
  return callback as Required<NotebookReferenceApi>[T]
}

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
        case 'notebooks.resolve':
          return callJsonSafe(() =>
            requireReferenceMethod(notebooksApi, 'resolve')(args[0])
          )
        case 'notebooks.show':
          return callJsonSafe(() =>
            requireReferenceMethod(notebooksApi, 'show')(args[0])
          )
        case 'notebooks.shareUrl':
          return callJsonSafe(() =>
            requireReferenceMethod(notebooksApi, 'shareUrl')(args[0])
          )
        case 'notebooks.markdownLink':
          return callJsonSafe(() =>
            requireReferenceMethod(notebooksApi, 'markdownLink')(args[0])
          )
        case 'notebooks.link':
          return callJsonSafe(() =>
            requireReferenceMethod(notebooksApi, 'link')(args[0])
          )
        default:
          throw new Error(`Unsupported sandbox NotebooksApi method: ${method}`)
      }
    },
  }
}
