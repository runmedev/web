// @vitest-environment node
import { create } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../runme/client'
import type { DriveNotebookStore } from '../storage/drive'
import { NotebookStoreItemType } from '../storage/notebook'
import {
  ResourceInsertionConflictError,
  attachResourceToNotebook,
} from './linkedResourceAttachments'
import { appState } from './runtime/AppState'
import type { NotebookDataLike } from './runtime/runmeConsole'

function fakeNotebook(uri = 'local://file/notebook'): NotebookDataLike & {
  updates: parser_pb.Cell[]
} {
  const notebook = create(parser_pb.NotebookSchema, { cells: [] })
  const updates: parser_pb.Cell[] = []
  return {
    updates,
    getUri: () => uri,
    getName: () => 'Demo notebook',
    getNotebook: () => notebook,
    updateCell: (cell) => {
      updates.push(cell)
      const index = notebook.cells.findIndex(
        (candidate) => candidate.refId === cell.refId
      )
      notebook.cells[index] = cell
    },
    getCell: () => null,
    appendCell: (kind, languageId) => {
      const cell = create(parser_pb.CellSchema, {
        refId: `cell-${notebook.cells.length + 1}`,
        kind,
        languageId: languageId ?? '',
      })
      notebook.cells.push(cell)
      return cell
    },
    removeCell: (refId) => {
      const index = notebook.cells.findIndex((cell) => cell.refId === refId)
      if (index >= 0) {
        notebook.cells.splice(index, 1)
      }
    },
    flushPendingPersist: vi.fn().mockResolvedValue(undefined),
  }
}

const metadata = {
  uri: 'https://drive.google.com/file/d/file-123/view',
  name: 'demo.webm',
  mimeType: 'video/webm',
  sizeBytes: 1234,
  modifiedTime: '2026-08-18T00:00:00Z',
  canDownload: true,
}

describe('attachResourceToNotebook', () => {
  afterEach(() => {
    appState.setDriveNotebookStore(null)
    appState.setLocalNotebooks(null)
  })

  it('attaches an existing Drive file without copying it', async () => {
    const getResourceMetadata = vi.fn().mockResolvedValue(metadata)
    appState.setDriveNotebookStore({
      getResourceMetadata,
    } as unknown as DriveNotebookStore)
    const notebook = fakeNotebook()

    const result = await attachResourceToNotebook(
      notebook,
      { kind: 'drive', uri: metadata.uri },
      { target: { uri: notebook.getUri() }, mode: 'video' }
    )

    expect(getResourceMetadata).toHaveBeenCalledWith(metadata.uri)
    expect(result.cell.languageId).toBe('runme-resource')
    expect(result.resource.hints?.mimeType).toBe('video/webm')
    expect(result.cell.value).not.toContain('access-token')
  })

  it('persists the resource key for an attached protected Drive file', async () => {
    const protectedMetadata = {
      ...metadata,
      uri: `${metadata.uri}?resourcekey=key_123`,
    }
    const getResourceMetadata = vi.fn().mockResolvedValue(protectedMetadata)
    appState.setDriveNotebookStore({
      getResourceMetadata,
    } as unknown as DriveNotebookStore)
    const notebook = fakeNotebook()

    const result = await attachResourceToNotebook(
      notebook,
      { kind: 'drive', uri: protectedMetadata.uri },
      { target: { uri: notebook.getUri() }, mode: 'video' }
    )

    expect(result.resource.source.uri).toBe(protectedMetadata.uri)
    expect(JSON.parse(result.cell.value).source.uri).toBe(protectedMetadata.uri)
    expect(notebook.getNotebook().cells[0]?.value).toContain(
      'resourcekey=key_123'
    )
  })

  it('attaches an HTTPS link without requiring Drive', async () => {
    const notebook = fakeNotebook()
    const result = await attachResourceToNotebook(
      notebook,
      { kind: 'url', uri: 'https://example.com/movie.webm' },
      { target: { uri: notebook.getUri() }, title: 'Movie' }
    )

    expect(result.resource.source.provider).toBe('https')
    expect(result.resource.presentation.mode).toBe('link')
  })

  it('does not insert a cell when upload fails', async () => {
    const notebook = fakeNotebook()
    appState.setDriveNotebookStore({
      getType: vi.fn().mockResolvedValue(NotebookStoreItemType.Folder),
      uploadResource: vi.fn().mockRejectedValue(new Error('upload failed')),
    } as unknown as DriveNotebookStore)

    await expect(
      attachResourceToNotebook(
        notebook,
        { kind: 'file', value: new Blob(['video'], { type: 'video/webm' }) },
        {
          target: { uri: notebook.getUri() },
          folderUri: 'https://drive.google.com/drive/folders/folder-123',
        }
      )
    ).rejects.toThrow('upload failed')
    expect(notebook.getNotebook().cells).toHaveLength(0)
  })

  it('reports the uploaded file when notebook insertion conflicts', async () => {
    const notebook = fakeNotebook()
    const uploadResource = vi.fn().mockImplementation(async () => {
      notebook.getNotebook().cells.push(
        create(parser_pb.CellSchema, {
          refId: 'concurrent-cell',
          kind: parser_pb.CellKind.MARKUP,
          value: 'changed',
        })
      )
      return metadata
    })
    appState.setDriveNotebookStore({
      getType: vi.fn().mockResolvedValue(NotebookStoreItemType.Folder),
      uploadResource,
    } as unknown as DriveNotebookStore)

    const error = await attachResourceToNotebook(
      notebook,
      { kind: 'file', value: new Blob(['video'], { type: 'video/webm' }) },
      {
        target: { uri: notebook.getUri() },
        folderUri: 'https://drive.google.com/drive/folders/folder-123',
      }
    ).catch((caught) => caught)

    expect(error).toBeInstanceOf(ResourceInsertionConflictError)
    expect(error.uploadedResource.uri).toBe(metadata.uri)
    expect(notebook.getNotebook().cells).toHaveLength(1)
  })

  it('removes an unsaved cell and reports the uploaded file when persistence fails', async () => {
    const notebook = fakeNotebook()
    vi.mocked(notebook.flushPendingPersist!).mockRejectedValue(
      new Error('disk full')
    )
    appState.setDriveNotebookStore({
      getType: vi.fn().mockResolvedValue(NotebookStoreItemType.Folder),
      uploadResource: vi.fn().mockResolvedValue(metadata),
    } as unknown as DriveNotebookStore)

    const error = await attachResourceToNotebook(
      notebook,
      { kind: 'file', value: new Blob(['video'], { type: 'video/webm' }) },
      {
        target: { uri: notebook.getUri() },
        folderUri: 'https://drive.google.com/drive/folders/folder-123',
      }
    ).catch((caught) => caught)

    expect(error).toBeInstanceOf(ResourceInsertionConflictError)
    expect(error.message).toContain(metadata.uri)
    expect(notebook.getNotebook().cells).toHaveLength(0)
  })
})
