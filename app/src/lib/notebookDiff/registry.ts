import { v4 as uuidv4 } from 'uuid'

import { showWorkspaceDocument } from '../workspaceDocuments/workspaceDocumentController'
import type { NotebookDiffDocument } from './model'

const documents = new Map<string, NotebookDiffDocument>()

export function registerNotebookDiffDocument(
  document: Omit<NotebookDiffDocument, 'id'> & { id?: string }
): NotebookDiffDocument {
  const id = document.id?.trim() || `notebook-diff-${uuidv4()}`
  const stored = { ...document, id }
  documents.set(id, stored)
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
