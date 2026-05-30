// @vitest-environment jsdom
import { create } from '@bufbuild/protobuf'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../../runme/client'
import {
  WORKSPACE_DOCUMENT_FOCUS_EVENT,
  __resetWorkspaceDocumentControllerForTests,
  getWorkspaceDocumentController,
} from '../workspaceDocuments/workspaceDocumentController'
import { computeNotebookDiff } from './diff'
import {
  getNotebookDiffDocumentUri,
  openNotebookDiffDocument,
  registerNotebookDiffDocument,
} from './registry'

function notebook(value: string) {
  return create(parser_pb.NotebookSchema, {
    cells: [
      create(parser_pb.CellSchema, {
        refId: 'cell-1',
        kind: parser_pb.CellKind.CODE,
        languageId: 'python',
        value,
      }),
    ],
    metadata: {},
  })
}

describe('notebook diff registry', () => {
  beforeEach(() => {
    __resetWorkspaceDocumentControllerForTests()
    window.sessionStorage.clear()
    window.history.replaceState(null, '', '/')
  })

  it('opens notebook diffs as focused workspace documents', () => {
    const focusListener = vi.fn()
    window.addEventListener(WORKSPACE_DOCUMENT_FOCUS_EVENT, focusListener)
    const diff = computeNotebookDiff(
      notebook("print('base')"),
      notebook("print('compare')")
    )
    const doc = registerNotebookDiffDocument({
      id: '%',
      base: { label: 'Drive revision 1', revisionId: '1' },
      compare: { label: 'Local copy', revisionId: 'local' },
      diff,
    })

    openNotebookDiffDocument(doc)

    const diffUri = getNotebookDiffDocumentUri(doc.id)
    expect(diffUri).toBe('diff://notebook/%25')
    expect(getWorkspaceDocumentController().getSnapshot().documents).toEqual([
      {
        uri: diffUri,
        title: 'Drive revision 1 vs Local copy',
      },
    ])
    expect(focusListener).toHaveBeenCalledTimes(1)
    expect((focusListener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      uri: diffUri,
    })
    expect(window.location.pathname).toBe('/')

    window.removeEventListener(WORKSPACE_DOCUMENT_FOCUS_EVENT, focusListener)
  })
})
