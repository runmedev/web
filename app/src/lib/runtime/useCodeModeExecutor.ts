import { useCallback, useMemo, useRef } from 'react'

import { parser_pb } from '../../contexts/CellContext'
import { useCurrentDoc } from '../../contexts/CurrentDocContext'
import { useNotebookContext } from '../../contexts/NotebookContext'
import { isNotebookDocumentUri } from '../workspaceDocuments/workspaceDocumentTypes'
import {
  type CodeModeExecutor,
  type CodeModeRunnerMode,
  createCodeModeExecutor,
} from './codeModeExecutor'
import type { NotebookDataLike } from './runmeConsole'

type CodeModeNotebookAdapterSource = Pick<
  NotebookDataLike,
  'getUri' | 'getName' | 'getNotebook' | 'updateCell' | 'getCell'
> &
  Partial<
    Pick<
      NotebookDataLike,
      'appendCell' | 'addCellAfter' | 'addCellBefore' | 'removeCell'
    >
  >

export function createCodeModeNotebookAdapter(
  data: CodeModeNotebookAdapterSource
): NotebookDataLike {
  return {
    getUri: () => data.getUri(),
    getName: () => data.getName(),
    getNotebook: () => data.getNotebook(),
    updateCell: (cell: parser_pb.Cell) => data.updateCell(cell),
    getCell: (refId: string) => data.getCell(refId),
    appendCell: data.appendCell?.bind(data),
    addCellAfter: data.addCellAfter?.bind(data),
    addCellBefore: data.addCellBefore?.bind(data),
    removeCell: data.removeCell?.bind(data),
  }
}

export function useCodeModeExecutor(options?: {
  mode?: CodeModeRunnerMode
}): CodeModeExecutor {
  const mode = options?.mode ?? 'sandbox'
  const { getNotebookData, useNotebookList } = useNotebookContext()
  const { getCurrentDoc } = useCurrentDoc()
  const currentDocUri = getCurrentDoc()
  const openNotebookList = useNotebookList()
  const getNotebookDataRef = useRef(getNotebookData)
  getNotebookDataRef.current = getNotebookData
  const openNotebookListRef = useRef(openNotebookList)
  openNotebookListRef.current = openNotebookList
  const currentDocUriRef = useRef(currentDocUri)
  currentDocUriRef.current = currentDocUri

  const resolveCodeModeNotebook = useCallback((target?: unknown) => {
    const targetUri =
      typeof target === 'string'
        ? target
        : typeof target === 'object' && target && 'uri' in target
          ? (target as { uri?: string }).uri
          : typeof target === 'object' &&
              target &&
              'handle' in target &&
              (target as { handle?: { uri?: string } }).handle?.uri
            ? (target as { handle?: { uri?: string } }).handle?.uri
            : currentDocUriRef.current
    if (!targetUri) {
      return null
    }
    if (!isNotebookDocumentUri(targetUri)) {
      return null
    }
    const data = getNotebookDataRef.current(targetUri)
    if (!data) {
      return null
    }

    return createCodeModeNotebookAdapter(data)
  }, [])

  return useMemo(
    () =>
      createCodeModeExecutor({
        mode,
        resolveNotebook: resolveCodeModeNotebook,
        listNotebooks: () => {
          const uris = new Set<string>()
          for (const notebook of openNotebookListRef.current) {
            if (typeof notebook?.uri === 'string' && notebook.uri.trim()) {
              uris.add(notebook.uri)
            }
          }
          if (currentDocUriRef.current) {
            uris.add(currentDocUriRef.current)
          }
          return Array.from(uris)
            .map((uri) => resolveCodeModeNotebook(uri))
            .filter(
              (
                notebook
              ): notebook is NonNullable<
                ReturnType<typeof resolveCodeModeNotebook>
              > => Boolean(notebook)
            )
        },
      }),
    [mode, resolveCodeModeNotebook]
  )
}
