import {
  type WorkspaceDocument,
  deriveWorkspaceDocumentTitle,
  isRestorableWorkspaceDocument,
} from './workspaceDocumentTypes'

const WORKSPACE_DOCUMENTS_STORAGE_KEY = 'runme/workspaceDocuments'

export interface WorkspaceDocumentSnapshot {
  documents: WorkspaceDocument[]
}

export interface WorkspaceDocumentPersistence {
  loadDocuments(): WorkspaceDocument[]
  saveDocuments(documents: WorkspaceDocument[]): void
}

export type ShowWorkspaceDocumentOptions = Omit<
  Partial<WorkspaceDocument>,
  'uri'
>

export const WORKSPACE_DOCUMENT_FOCUS_EVENT = 'runme:workspace-document-focus'

export interface WorkspaceDocumentFocusEventDetail {
  uri: string
}

export function focusWorkspaceDocument(uri: string): void {
  if (typeof window === 'undefined') {
    return
  }
  window.dispatchEvent(
    new CustomEvent<WorkspaceDocumentFocusEventDetail>(
      WORKSPACE_DOCUMENT_FOCUS_EVENT,
      {
        detail: { uri },
      }
    )
  )
}

export function showWorkspaceDocument(
  uri: string,
  options?: ShowWorkspaceDocumentOptions
): void {
  getWorkspaceDocumentController().showDocument(uri, options)
  focusWorkspaceDocument(uri)
}

class SessionStorageWorkspaceDocumentPersistence
  implements WorkspaceDocumentPersistence
{
  loadDocuments(): WorkspaceDocument[] {
    if (typeof window === 'undefined' || !window.sessionStorage) {
      return []
    }
    try {
      const raw = window.sessionStorage.getItem(WORKSPACE_DOCUMENTS_STORAGE_KEY)
      if (!raw) {
        return []
      }
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) {
        return []
      }
      return parsed
        .map(normalizeWorkspaceDocument)
        .filter((item): item is WorkspaceDocument => Boolean(item))
    } catch {
      return []
    }
  }

  saveDocuments(documents: WorkspaceDocument[]): void {
    if (typeof window === 'undefined' || !window.sessionStorage) {
      return
    }
    try {
      const restorable = documents.filter((item) =>
        isRestorableWorkspaceDocument(item.uri)
      )
      if (restorable.length === 0) {
        window.sessionStorage.removeItem(WORKSPACE_DOCUMENTS_STORAGE_KEY)
        return
      }
      const persisted = restorable.map((item) => ({
        uri: item.uri,
        title: item.title,
        requestedUri: item.requestedUri,
        mimeType: item.mimeType,
      }))
      window.sessionStorage.setItem(
        WORKSPACE_DOCUMENTS_STORAGE_KEY,
        JSON.stringify(persisted)
      )
    } catch {
      // Ignore restore-state persistence failures.
    }
  }
}

function normalizeWorkspaceDocument(item: unknown): WorkspaceDocument | null {
  if (!item || typeof item !== 'object') {
    return null
  }
  const candidate = item as Partial<WorkspaceDocument>
  const uri = candidate.uri?.trim()
  if (!uri) {
    return null
  }
  return {
    uri,
    title: candidate.title?.trim() || deriveWorkspaceDocumentTitle(uri),
    requestedUri: candidate.requestedUri?.trim() || undefined,
    mimeType: candidate.mimeType?.trim() || undefined,
  }
}

export class WorkspaceDocumentController {
  private documents: WorkspaceDocument[] = []
  private snapshot: WorkspaceDocumentSnapshot = { documents: [] }
  private readonly listeners = new Set<() => void>()
  private restored = false

  constructor(
    private persistence: WorkspaceDocumentPersistence = new SessionStorageWorkspaceDocumentPersistence()
  ) {}

  getSnapshot(): WorkspaceDocumentSnapshot {
    this.ensureRestored()
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.ensureRestored()
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  showDocument(uri: string, options?: ShowWorkspaceDocumentOptions): void {
    this.ensureRestored()
    const normalizedUri = uri.trim()
    if (!normalizedUri) {
      throw new Error('showDocument requires a non-empty URI')
    }
    const title =
      options?.title?.trim() || deriveWorkspaceDocumentTitle(normalizedUri)
    const nextDocument: WorkspaceDocument = {
      uri: normalizedUri,
      title,
      requestedUri: options?.requestedUri,
      mimeType: options?.mimeType,
      state: options?.state,
      readOnly: options?.readOnly,
      errorMessage: options?.errorMessage,
      owner: options?.owner,
    }
    const existingIndex = this.documents.findIndex(
      (item) => item.uri === normalizedUri
    )
    if (existingIndex >= 0) {
      const existing = this.documents[existingIndex]
      if (
        existing?.title === nextDocument.title &&
        existing?.requestedUri === nextDocument.requestedUri &&
        existing?.mimeType === nextDocument.mimeType &&
        existing?.state === nextDocument.state &&
        existing?.readOnly === nextDocument.readOnly &&
        existing?.errorMessage === nextDocument.errorMessage &&
        existing?.owner === nextDocument.owner
      ) {
        return
      }
      this.documents = this.documents.map((item, index) =>
        index === existingIndex ? nextDocument : item
      )
    } else {
      this.documents = [...this.documents, nextDocument]
    }
    this.emit()
    this.persist()
  }

  closeDocument(uri: string): string | null {
    this.ensureRestored()
    const index = this.documents.findIndex((item) => item.uri === uri)
    if (index === -1) {
      return null
    }
    const fallback =
      index > 0
        ? (this.documents[index - 1]?.uri ?? null)
        : (this.documents[index + 1]?.uri ?? null)
    this.documents = this.documents.filter((item) => item.uri !== uri)
    this.emit()
    this.persist()
    return fallback
  }

  resetForTests(): void {
    this.documents = []
    this.snapshot = { documents: [] }
    this.listeners.clear()
    this.restored = false
  }

  private ensureRestored(): void {
    if (this.restored) {
      return
    }
    this.restored = true
    this.documents = this.persistence
      .loadDocuments()
      .filter((item) => isRestorableWorkspaceDocument(item.uri))
    this.rebuildSnapshot()
  }

  private emit(): void {
    this.rebuildSnapshot()
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.error('WorkspaceDocumentController listener failed', error)
      }
    }
  }

  private persist(): void {
    this.persistence.saveDocuments(this.documents)
  }

  private rebuildSnapshot(): void {
    this.snapshot = {
      documents: this.documents.map((item) => ({ ...item })),
    }
  }
}

let controller: WorkspaceDocumentController | null = null

export function getWorkspaceDocumentController(): WorkspaceDocumentController {
  if (!controller) {
    controller = new WorkspaceDocumentController()
  }
  return controller
}

export function __resetWorkspaceDocumentControllerForTests(): void {
  controller?.resetForTests()
  controller = null
}
