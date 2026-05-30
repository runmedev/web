import { v4 as uuidv4 } from 'uuid'

import { showWorkspaceDocument } from '../workspaceDocuments/workspaceDocumentController'
import type { NotebookDiffDocument } from './model'

const documents = new Map<string, NotebookDiffDocument>()

export const NOTEBOOK_DIFF_DOCUMENT_CHANGED =
  'runme:notebook-diff-document-changed'

export interface NotebookDiffDocumentChangedDetail {
  id: string
}

export function registerNotebookDiffDocument(
  document: Omit<NotebookDiffDocument, 'id'> & { id?: string }
): NotebookDiffDocument {
  const id = document.id?.trim() || `notebook-diff-${uuidv4()}`
  const stored = { ...document, id }
  documents.set(id, stored)
  emitNotebookDiffDocumentChanged(id)
  return stored
}

export function getNotebookDiffDocument(
  id: string
): NotebookDiffDocument | null {
  return documents.get(id) ?? null
}

export function getNotebookDiffDocumentUri(id: string): string {
  return `diff://notebook/${encodeURIComponent(id)}`
}

function getNotebookDiffDocumentTitle(
  document: NotebookDiffDocument | null
): string {
  if (!document) {
    return 'Notebook diff'
  }
  return `${document.base.label} vs ${document.compare.label}`
}

export function openNotebookDiffDocument(
  document: NotebookDiffDocument | { id: string }
): void {
  const id = document.id.trim()
  if (!id) {
    throw new Error('openDiffTab requires a diff document id')
  }
  const storedDocument = getNotebookDiffDocument(id)
  showWorkspaceDocument(getNotebookDiffDocumentUri(id), {
    title: getNotebookDiffDocumentTitle(storedDocument),
  })
}

function emitNotebookDiffDocumentChanged(id: string): void {
  if (typeof window === 'undefined') {
    return
  }
  window.dispatchEvent(
    new CustomEvent<NotebookDiffDocumentChangedDetail>(
      NOTEBOOK_DIFF_DOCUMENT_CHANGED,
      {
        detail: { id },
      }
    )
  )
}
