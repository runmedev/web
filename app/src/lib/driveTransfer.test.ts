import { create } from '@bufbuild/protobuf'
import md5 from 'md5'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../runme/client'
import {
  DriveCreateNotCommittedError,
  DriveFileCreatedError,
} from '../storage/drive'
import { NotebookStoreItemType } from '../storage/notebook'
import {
  copyDriveNotebookFile,
  createDriveFile,
  createDriveNotebook,
  listDriveFolderItems,
  mountDriveFolder,
  saveNotebookAsDriveCopy,
  searchDriveFiles,
  updateDriveFileBytes,
} from './driveTransfer'
import { encodeRunmeNotebook } from './notebookFormat'
import { appState } from './runtime/AppState'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  appState.setDriveNotebookStore(null)
  appState.setLocalNotebooks(null)
  appState.setOpenNotebookHandler(null)
  appState.setWorkspaceHandlers(null)
})

describe('driveTransfer', () => {
  it('creates a drive file and returns parsed id', async () => {
    const create = vi.fn().mockResolvedValue({
      uri: 'https://drive.google.com/file/d/abc123/view',
    })
    appState.setDriveNotebookStore({ create } as any)

    const id = await createDriveFile('folder123', 'notes.md')
    expect(id).toBe('abc123')
    expect(create).toHaveBeenCalledWith(
      'https://drive.google.com/drive/folders/folder123',
      'notes.md'
    )
  })

  it('updates drive file bytes using saveContent', async () => {
    const saveContent = vi.fn().mockResolvedValue(undefined)
    appState.setDriveNotebookStore({ saveContent } as any)

    const id = await updateDriveFileBytes(
      'abc123',
      new TextEncoder().encode('hello')
    )

    expect(id).toBe('abc123')
    expect(saveContent).toHaveBeenCalledWith(
      'https://drive.google.com/file/d/abc123/view',
      'hello',
      'text/markdown'
    )
  })

  it('lists drive folder items', async () => {
    const list = vi.fn().mockResolvedValue([
      {
        uri: 'https://drive.google.com/file/d/abc123/view',
        name: 'abc123.json',
        type: NotebookStoreItemType.File,
        children: [],
        parents: [],
      },
    ])
    appState.setDriveNotebookStore({ list } as any)

    const items = await listDriveFolderItems('folder123')

    expect(list).toHaveBeenCalledWith(
      'https://drive.google.com/drive/folders/folder123'
    )
    expect(items).toHaveLength(1)
  })

  it('forwards Google Drive files.list search requests', async () => {
    const request = {
      q: "name = 'eval_read.json' and trashed = false",
      pageSize: 25,
      fields: 'nextPageToken,files(id,name,mimeType)',
    }
    const expected = {
      files: [
        {
          id: 'abc123',
          name: 'eval_read.json',
          mimeType: 'application/json',
          uri: 'https://drive.google.com/file/d/abc123/view',
        },
      ],
      nextPageToken: 'next-page',
    }
    const search = vi.fn().mockResolvedValue(expected)
    appState.setDriveNotebookStore({ search } as any)

    const result = await searchDriveFiles(request)

    expect(search).toHaveBeenCalledWith(request)
    expect(result).toEqual(expected)
  })

  it('rejects non-object Drive search requests', async () => {
    appState.setDriveNotebookStore({ search: vi.fn() } as any)

    await expect(
      searchDriveFiles("name = 'eval_read.json'" as any)
    ).rejects.toThrow(
      'drive.search requires a Google Drive files.list request object'
    )
  })

  it('mirrors and mounts an accessible Drive folder', async () => {
    const remoteUri = 'https://drive.google.com/drive/folders/folder123'
    const updateFolder = vi.fn().mockResolvedValue('local://folder/folder123')
    const getMetadata = vi.fn().mockResolvedValue({ name: 'notebooks' })
    appState.setLocalNotebooks({ updateFolder, getMetadata } as any)

    let workspaceItems: string[] = []
    const addItem = vi.fn((uri: string) => {
      workspaceItems = [...workspaceItems, uri]
    })
    appState.setWorkspaceHandlers({
      getItems: () => workspaceItems,
      addItem,
      removeItem: vi.fn(),
    })

    const result = await mountDriveFolder('folder123')

    expect(updateFolder).toHaveBeenCalledWith(remoteUri)
    expect(addItem).toHaveBeenCalledWith('local://folder/folder123')
    expect(result).toEqual({
      folderId: 'folder123',
      name: 'notebooks',
      remoteUri,
      localUri: 'local://folder/folder123',
      alreadyMounted: false,
    })
  })

  it('reports an already-mounted Drive folder without duplicating workspace state', async () => {
    const remoteUri = 'https://drive.google.com/drive/folders/folder123'
    const localUri = 'local://folder/folder123'
    appState.setLocalNotebooks({
      updateFolder: vi.fn().mockResolvedValue(localUri),
      getMetadata: vi.fn().mockResolvedValue({ name: 'notebooks' }),
    } as any)
    const addItem = vi.fn()
    appState.setWorkspaceHandlers({
      getItems: () => [localUri],
      addItem,
      removeItem: vi.fn(),
    })

    const result = await mountDriveFolder(remoteUri)

    expect(result.alreadyMounted).toBe(true)
    expect(addItem).toHaveBeenCalledWith(localUri)
  })

  it('normalizes a remote workspace entry to its local Drive mirror', async () => {
    const remoteUri = 'https://drive.google.com/drive/folders/folder123'
    const localUri = 'local://folder/folder123'
    appState.setLocalNotebooks({
      updateFolder: vi.fn().mockResolvedValue(localUri),
      getMetadata: vi.fn().mockResolvedValue({ name: 'notebooks' }),
    } as any)
    const addItem = vi.fn()
    const removeItem = vi.fn()
    appState.setWorkspaceHandlers({
      getItems: () => [remoteUri],
      addItem,
      removeItem,
    })

    const result = await mountDriveFolder(remoteUri)

    expect(result.alreadyMounted).toBe(true)
    expect(removeItem).toHaveBeenCalledWith(remoteUri)
    expect(addItem).toHaveBeenCalledWith(localUri)
  })

  it('copies a notebook file to another drive folder', async () => {
    const sourceUri = 'https://drive.google.com/file/d/src123/view'
    const destinationUri = 'https://drive.google.com/file/d/copied123/view'
    const notebook = create(parser_pb.NotebookSchema, { cells: [] })
    const getMetadata = vi.fn().mockResolvedValue({
      uri: sourceUri,
      name: 'source.json',
      type: NotebookStoreItemType.File,
      children: [],
      parents: [],
    })
    const load = vi.fn().mockResolvedValue(notebook)
    const createRemote = vi.fn().mockResolvedValue({ uri: destinationUri })
    const save = vi.fn().mockResolvedValue({ conflicted: false })
    appState.setDriveNotebookStore({
      getMetadata,
      load,
      create: createRemote,
      save,
    } as any)

    const result = await copyDriveNotebookFile('src123', 'folder999')

    expect(getMetadata).toHaveBeenCalledWith(sourceUri)
    expect(load).toHaveBeenCalledWith(sourceUri)
    expect(createRemote).toHaveBeenCalledWith(
      'https://drive.google.com/drive/folders/folder999',
      'source.json'
    )
    expect(save).toHaveBeenCalledWith(destinationUri, notebook)
    expect(result).toEqual({
      fileId: 'copied123',
      fileName: 'source.json',
      sourceUri,
      targetUri: destinationUri,
    })
  })

  it('copies ipynb bytes without dropping Jupyter-only fields', async () => {
    const sourceUri = 'https://drive.google.com/file/d/src123/view'
    const destinationUri = 'https://drive.google.com/file/d/copied123/view'
    const sourceText = JSON.stringify({
      cells: [],
      metadata: { colab: { provenance: ['keep-me'] } },
      nbformat: 4,
      nbformat_minor: 5,
    })
    const getMetadata = vi.fn().mockResolvedValue({
      uri: sourceUri,
      name: 'source.ipynb',
      type: NotebookStoreItemType.File,
      children: [],
      parents: [],
    })
    const loadContent = vi.fn().mockResolvedValue(sourceText)
    const createContent = vi.fn().mockResolvedValue({ uri: destinationUri })
    appState.setDriveNotebookStore({
      getMetadata,
      loadContent,
      createContent,
    } as any)

    await copyDriveNotebookFile('src123', 'folder999')

    expect(createContent).toHaveBeenCalledWith(
      'https://drive.google.com/drive/folders/folder999',
      'source.ipynb',
      sourceText,
      'application/x-ipynb+json'
    )
  })

  it('saves a notebook as a drive copy, mirrors locally, and switches current doc', async () => {
    let uploadedContent = ''
    const createContent = vi
      .fn()
      .mockImplementation(async (_folder, _name, content) => {
        uploadedContent = content
        return {
          uri: 'https://drive.google.com/file/d/drive123/view',
          name: 'copy.json',
        }
      })
    const getVersionMetadata = vi.fn().mockImplementation(async () => ({
      md5Checksum: md5(uploadedContent),
      headRevisionId: 'drive-revision-1',
    }))
    appState.setDriveNotebookStore({
      createContent,
      getVersionMetadata,
    } as any)

    const addFile = vi.fn().mockResolvedValue('local://file/new-copy')
    const initializeUploadedDriveNotebook = vi.fn().mockResolvedValue(true)
    appState.setLocalNotebooks({
      addFile,
      initializeUploadedDriveNotebook,
    } as any)

    const openNotebook = vi.fn().mockResolvedValue(undefined)
    appState.setOpenNotebookHandler(openNotebook)

    const notebook = create(parser_pb.NotebookSchema, { cells: [] })

    const result = await saveNotebookAsDriveCopy(
      notebook,
      'folder123',
      'copy.json'
    )

    expect(result.fileId).toBe('drive123')
    expect(result.remoteUri).toBe(
      'https://drive.google.com/file/d/drive123/view'
    )
    expect(result.localUri).toBe('local://file/new-copy')
    expect(addFile).toHaveBeenCalledWith(result.remoteUri, 'copy.json', {
      mimeType: 'application/json',
    })
    expect(initializeUploadedDriveNotebook).toHaveBeenCalledWith(
      'local://file/new-copy',
      notebook,
      uploadedContent,
      {
        checksum: md5(uploadedContent),
        revisionId: 'drive-revision-1',
      }
    )
    expect(openNotebook).toHaveBeenCalledWith('local://file/new-copy')
    expect(createContent).toHaveBeenCalledWith(
      'https://drive.google.com/drive/folders/folder123',
      'copy.json',
      uploadedContent,
      'application/json',
      {}
    )
  })

  it('rejects a Drive copy name that the explorer cannot reopen', async () => {
    const createContent = vi.fn()
    appState.setDriveNotebookStore({ createContent } as any)

    await expect(
      saveNotebookAsDriveCopy(
        create(parser_pb.NotebookSchema, { cells: [] }),
        'folder123',
        'hidden-notebook.md'
      )
    ).rejects.toThrow('must end in .json or .ipynb')
    expect(createContent).not.toHaveBeenCalled()
  })

  it('initializes the mirror when metadata is unavailable after upload', async () => {
    const createContent = vi.fn().mockResolvedValue({
      uri: 'https://drive.google.com/file/d/committed123/view',
      name: 'committed.json',
      parents: ['https://drive.google.com/drive/folders/folder123'],
    })
    appState.setDriveNotebookStore({
      createContent,
      getVersionMetadata: vi.fn().mockRejectedValue(new Error('temporary 503')),
    } as any)
    const initializeUploadedDriveNotebook = vi.fn().mockResolvedValue(true)
    appState.setLocalNotebooks({
      addFile: vi.fn().mockResolvedValue('local://file/committed'),
      attachDriveFileToFolder: vi
        .fn()
        .mockResolvedValue('local://folder/drive'),
      initializeUploadedDriveNotebook,
    } as any)
    appState.setOpenNotebookHandler(vi.fn().mockResolvedValue(undefined))

    await expect(
      saveNotebookAsDriveCopy(
        create(parser_pb.NotebookSchema, { cells: [] }),
        'folder123',
        'committed.json'
      )
    ).resolves.toMatchObject({ fileId: 'committed123' })

    expect(createContent).toHaveBeenCalledTimes(1)
    expect(initializeUploadedDriveNotebook).toHaveBeenCalledWith(
      'local://file/committed',
      expect.objectContaining({ cells: [] }),
      expect.any(String),
      { checksum: expect.any(String), revisionId: undefined }
    )
  })

  it('creates a Drive-backed notebook without a local-only source', async () => {
    let uploadedContent = ''
    const findByCreateOperation = vi.fn().mockResolvedValue(null)
    const createContent = vi
      .fn()
      .mockImplementation(async (_folder, _name, content) => {
        uploadedContent = content
        return {
          uri: 'https://drive.google.com/file/d/drive123/view',
          name: 'new.ipynb',
        }
      })
    const getVersionMetadata = vi.fn().mockImplementation(async () => ({
      md5Checksum: md5(uploadedContent),
      headRevisionId: 'drive-revision-1',
    }))
    const loadContent = vi.fn().mockImplementation(async () => uploadedContent)
    const markCreateOperationComplete = vi.fn().mockResolvedValue(undefined)
    const waitForCreateOperation = vi.fn().mockResolvedValue(null)
    appState.setDriveNotebookStore({
      findByCreateOperation,
      generateFileId: vi.fn().mockResolvedValue('reserved-drive123'),
      getMetadataIfExists: vi.fn().mockResolvedValue(null),
      waitForCreateOperation,
      createContent,
      getVersionMetadata,
      loadContent,
      markCreateOperationComplete,
    } as any)

    const addFile = vi.fn().mockResolvedValue('local://file/drive-mirror')
    const attachDriveFileToFolder = vi
      .fn()
      .mockResolvedValue('local://folder/drive')
    const initializeUploadedDriveNotebook = vi.fn().mockResolvedValue(true)
    appState.setLocalNotebooks({
      addFile,
      attachDriveFileToFolder,
      initializeUploadedDriveNotebook,
    } as any)

    const openNotebook = vi.fn().mockResolvedValue(undefined)
    appState.setOpenNotebookHandler(openNotebook)

    const result = await createDriveNotebook('folder123', 'new.ipynb', {
      idempotencyKey: 'create-new-ipynb',
      cells: [
        {
          kind: 'markup',
          value: '# New notebook',
          metadata: { name: 'title' },
        },
      ],
    })

    expect(result).toEqual({
      fileId: 'drive123',
      fileName: 'new.ipynb',
      remoteUri: 'https://drive.google.com/file/d/drive123/view',
      localUri: 'local://file/drive-mirror',
    })
    expect(addFile).toHaveBeenCalledTimes(1)
    expect(addFile).toHaveBeenCalledWith(result.remoteUri, 'new.ipynb', {
      mimeType: 'application/x-ipynb+json',
    })
    expect(attachDriveFileToFolder).toHaveBeenCalledWith(
      'https://drive.google.com/drive/folders/folder123',
      result.localUri
    )
    expect(initializeUploadedDriveNotebook).toHaveBeenCalledWith(
      result.localUri,
      expect.objectContaining({
        cells: [
          expect.objectContaining({
            kind: parser_pb.CellKind.MARKUP,
            languageId: 'markdown',
            value: '# New notebook',
            metadata: expect.objectContaining({ name: 'title' }),
          }),
        ],
      }),
      expect.any(String),
      {
        checksum: md5(uploadedContent),
        revisionId: 'drive-revision-1',
      }
    )
    expect(findByCreateOperation).toHaveBeenCalledWith(
      'https://drive.google.com/drive/folders/folder123',
      expect.stringMatching(/^[a-f0-9]{64}$/)
    )
    expect(waitForCreateOperation).toHaveBeenCalledWith(
      'https://drive.google.com/drive/folders/folder123',
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.any(Number)
    )
    expect(createContent).toHaveBeenCalledWith(
      'https://drive.google.com/drive/folders/folder123',
      'new.ipynb',
      uploadedContent,
      'application/x-ipynb+json',
      {
        createOperationId: expect.stringMatching(/^[a-f0-9]{64}$/),
        expectedContentChecksum: md5(uploadedContent),
        expectedRequestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        fileId: 'reserved-drive123',
      }
    )
    expect(markCreateOperationComplete).toHaveBeenCalledWith(
      result.remoteUri,
      md5(uploadedContent)
    )
    expect(openNotebook).toHaveBeenCalledWith(result.localUri)
  })

  it('creates directly in a Shared Drive without a pre-generated file id', async () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    })
    let uploadedContent = ''
    const generateFileId = vi.fn()
    const createContent = vi
      .fn()
      .mockImplementation(
        async (_folder, _name, content, _mimeType, options) => {
          uploadedContent = content
          expect(options.fileId).toBeUndefined()
          return {
            uri: 'https://drive.google.com/file/d/shared123/view',
            name: 'shared.json',
            parents: ['https://drive.google.com/drive/folders/folder123'],
          }
        }
      )
    appState.setDriveNotebookStore({
      canUsePreGeneratedFileId: vi.fn().mockResolvedValue(false),
      generateFileId,
      getMetadataIfExists: vi.fn(),
      findByCreateOperation: vi.fn().mockResolvedValue(null),
      createContent,
      getVersionMetadata: vi.fn().mockImplementation(async () => ({
        md5Checksum: md5(uploadedContent),
        appProperties: {
          runmeCreateCompletedChecksum: md5(uploadedContent),
        },
      })),
      loadContent: vi.fn().mockImplementation(async () => uploadedContent),
    } as any)
    appState.setLocalNotebooks({
      addFile: vi.fn().mockResolvedValue('local://file/shared'),
      attachDriveFileToFolder: vi
        .fn()
        .mockResolvedValue('local://folder/shared'),
      initializeUploadedDriveNotebook: vi.fn().mockResolvedValue(true),
    } as any)
    appState.setOpenNotebookHandler(vi.fn().mockResolvedValue(undefined))

    await expect(
      createDriveNotebook('folder123', 'shared.json', {
        idempotencyKey: 'shared-create',
      })
    ).resolves.toMatchObject({ fileId: 'shared123' })

    expect(generateFileId).not.toHaveBeenCalled()
    expect(createContent).toHaveBeenCalledTimes(1)
  })

  it('adopts the same Drive file when an idempotent creation is retried', async () => {
    const remoteFile = {
      uri: 'https://drive.google.com/file/d/drive123/view',
      name: 'retry.json',
    }
    let uploadedContent = ''
    const findByCreateOperation = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(remoteFile)
    const createContent = vi
      .fn()
      .mockImplementation(async (_folder, _name, content) => {
        uploadedContent = content
        return remoteFile
      })
    let completed = false
    const getVersionMetadata = vi.fn().mockImplementation(async () => ({
      md5Checksum: md5(uploadedContent),
      headRevisionId: 'drive-revision-1',
      appProperties: completed
        ? { runmeCreateCompletedChecksum: md5(uploadedContent) }
        : {},
    }))
    const loadContent = vi.fn().mockImplementation(async () => uploadedContent)
    const markCreateOperationComplete = vi.fn().mockImplementation(async () => {
      completed = true
    })
    const getMetadata = vi.fn().mockResolvedValue({
      ...remoteFile,
      name: 'retry-renamed.json',
    })
    appState.setDriveNotebookStore({
      findByCreateOperation,
      createContent,
      getVersionMetadata,
      loadContent,
      markCreateOperationComplete,
      getMetadata,
    } as any)
    const initializeUploadedDriveNotebook = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false)
    const reconcileDriveNotebook = vi.fn().mockResolvedValue(undefined)
    const addFile = vi.fn().mockResolvedValue('local://file/drive-mirror')
    appState.setLocalNotebooks({
      addFile,
      initializeUploadedDriveNotebook,
      reconcileDriveNotebook,
    } as any)
    const openNotebook = vi
      .fn()
      .mockRejectedValueOnce(new Error('tab failed to open'))
      .mockResolvedValue(undefined)
    appState.setOpenNotebookHandler(openNotebook)

    const createOnce = () =>
      createDriveNotebook('folder123', 'retry.json', {
        idempotencyKey: 'create-retry-json',
        cells: [{ kind: 'markup', value: '# Retry-safe notebook' }],
      })

    await expect(createOnce()).rejects.toThrow('tab failed to open')
    await expect(createOnce()).resolves.toMatchObject({
      fileId: 'drive123',
      fileName: 'retry-renamed.json',
    })

    expect(createContent).toHaveBeenCalledTimes(1)
    // The durable attempt record remembers the returned Drive URI, so the
    // retry does not depend on Drive search indexing.
    expect(findByCreateOperation).toHaveBeenCalledTimes(1)
    expect(getMetadata).toHaveBeenCalledWith(remoteFile.uri)
    expect(addFile).toHaveBeenLastCalledWith(
      remoteFile.uri,
      'retry-renamed.json',
      {
        mimeType: 'application/json',
      }
    )
    expect(loadContent).toHaveBeenCalledWith(remoteFile.uri)
    expect(reconcileDriveNotebook).toHaveBeenCalledWith(
      'local://file/drive-mirror'
    )
  })

  it('does not overwrite a Drive edit made before completion was marked', async () => {
    const remoteFile = {
      uri: 'https://drive.google.com/file/d/edited123/view',
      name: 'edited.json',
    }
    const editedContent = encodeRunmeNotebook(
      create(parser_pb.NotebookSchema, {
        cells: [
          create(parser_pb.CellSchema, {
            kind: parser_pb.CellKind.MARKUP,
            value: '# Collaborator edit',
          }),
        ],
      })
    )
    const saveContent = vi.fn()
    appState.setDriveNotebookStore({
      findByCreateOperation: vi.fn().mockResolvedValue(remoteFile),
      getVersionMetadata: vi.fn().mockResolvedValue({
        md5Checksum: md5(editedContent),
        headRevisionId: 'collaborator-revision',
        appProperties: {},
      }),
      loadContent: vi.fn().mockResolvedValue(editedContent),
      saveContent,
    } as any)

    await expect(
      createDriveNotebook('folder123', 'edited.json', {
        idempotencyKey: 'edited-before-completion',
      })
    ).rejects.toThrow('changed before creation completed')
    expect(saveContent).not.toHaveBeenCalled()
  })

  it('repairs an adopted file whose initial media upload was interrupted', async () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    })
    const remoteFile = {
      uri: 'https://drive.google.com/file/d/partial123/view',
      name: 'recovered.json',
    }
    let remoteContent = ''
    let completedChecksum = ''
    let metadataCreated = false
    const findByCreateOperation = vi
      .fn()
      .mockImplementation(async () => (metadataCreated ? remoteFile : null))
    const createContent = vi.fn().mockImplementation(async () => {
      metadataCreated = true
      throw new DriveFileCreatedError(
        'partial123',
        'recovered.json',
        new Error('media upload interrupted'),
        'metadata-revision'
      )
    })
    const saveContentIfVersion = vi
      .fn()
      .mockImplementation(async (_uri, content) => {
        remoteContent = content
        return true
      })
    const getVersionMetadata = vi.fn().mockImplementation(async () => ({
      md5Checksum: md5(remoteContent),
      headRevisionId:
        remoteContent === '' ? 'metadata-revision' : 'recovered-revision',
      appProperties: completedChecksum
        ? { runmeCreateCompletedChecksum: completedChecksum }
        : {},
    }))
    const loadContent = vi.fn().mockImplementation(async () => remoteContent)
    const markCreateOperationComplete = vi
      .fn()
      .mockImplementation(async (_uri, checksum) => {
        completedChecksum = checksum
      })
    appState.setDriveNotebookStore({
      findByCreateOperation,
      createContent,
      saveContentIfVersion,
      getVersionMetadata,
      loadContent,
      markCreateOperationComplete,
    } as any)
    appState.setLocalNotebooks({
      addFile: vi.fn().mockResolvedValue('local://file/recovered'),
      initializeUploadedDriveNotebook: vi.fn().mockResolvedValue(true),
    } as any)
    appState.setOpenNotebookHandler(vi.fn().mockResolvedValue(undefined))

    const createOnce = () =>
      createDriveNotebook('folder123', 'recovered.json', {
        idempotencyKey: '重'.repeat(128),
        cells: [{ kind: 'markup', value: '# Recovered' }],
      })

    await expect(createOnce()).rejects.toBeInstanceOf(DriveFileCreatedError)
    const result = await createOnce()

    expect(result.fileId).toBe('partial123')
    expect(createContent).toHaveBeenCalledTimes(1)
    expect(saveContentIfVersion).toHaveBeenCalledWith(
      remoteFile.uri,
      expect.stringContaining('Recovered'),
      'application/json',
      {
        checksum: md5(''),
        revisionId: 'metadata-revision',
      }
    )
    expect(markCreateOperationComplete).toHaveBeenCalledWith(
      remoteFile.uri,
      md5(remoteContent)
    )
    expect(findByCreateOperation).toHaveBeenCalledWith(
      'https://drive.google.com/drive/folders/folder123',
      expect.stringMatching(/^[a-f0-9]{64}$/)
    )
  })

  it('does not repair an incomplete upload after its checked revision changes', async () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    })
    const remoteFile = {
      uri: 'https://drive.google.com/file/d/raced123/view',
      name: 'raced.json',
    }
    let metadataCreated = false
    const markCreateOperationComplete = vi.fn()
    const saveContentIfVersion = vi.fn()
    appState.setDriveNotebookStore({
      findByCreateOperation: vi
        .fn()
        .mockImplementation(async () => (metadataCreated ? remoteFile : null)),
      createContent: vi.fn().mockImplementation(async () => {
        metadataCreated = true
        throw new DriveFileCreatedError(
          'raced123',
          'raced.json',
          new Error('media upload interrupted'),
          'metadata-revision'
        )
      }),
      getVersionMetadata: vi.fn().mockResolvedValue({
        md5Checksum: md5(''),
        headRevisionId: 'collaborator-empty-revision',
        appProperties: {},
      }),
      loadContent: vi.fn().mockResolvedValue(''),
      saveContentIfVersion,
      markCreateOperationComplete,
    } as any)

    const createOnce = () =>
      createDriveNotebook('folder123', 'raced.json', {
        idempotencyKey: 'repair-race',
      })

    await expect(createOnce()).rejects.toBeInstanceOf(DriveFileCreatedError)
    await expect(createOnce()).rejects.toThrow(
      'changed before creation completed'
    )
    expect(saveContentIfVersion).not.toHaveBeenCalled()
    expect(markCreateOperationComplete).not.toHaveBeenCalled()
  })

  it('allows a definitely uncommitted create to retry with the same key', async () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    })
    let uploadedContent = ''
    const createContent = vi
      .fn()
      .mockRejectedValueOnce(
        new DriveCreateNotCommittedError('access denied before create')
      )
      .mockImplementationOnce(async (_folder, _name, content) => {
        uploadedContent = content
        return {
          uri: 'https://drive.google.com/file/d/retried123/view',
          name: 'retried.json',
        }
      })
    appState.setDriveNotebookStore({
      findByCreateOperation: vi.fn().mockResolvedValue(null),
      createContent,
      getVersionMetadata: vi.fn().mockImplementation(async () => ({
        md5Checksum: md5(uploadedContent),
        headRevisionId: 'retried-revision',
        appProperties: {
          runmeCreateCompletedChecksum: md5(uploadedContent),
        },
      })),
      loadContent: vi.fn().mockImplementation(async () => uploadedContent),
    } as any)
    appState.setLocalNotebooks({
      addFile: vi.fn().mockResolvedValue('local://file/retried'),
      initializeUploadedDriveNotebook: vi.fn().mockResolvedValue(true),
    } as any)
    appState.setOpenNotebookHandler(vi.fn().mockResolvedValue(undefined))
    const createOnce = () =>
      createDriveNotebook('folder123', 'retried.json', {
        idempotencyKey: 'retry-after-precommit',
      })

    await expect(createOnce()).rejects.toThrow('access denied before create')
    await expect(createOnce()).resolves.toMatchObject({ fileId: 'retried123' })
    expect(createContent).toHaveBeenCalledTimes(2)
  })

  it('retries a crashed create with the same preallocated Drive file id', async () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    })
    let uploadedContent = ''
    const createContent = vi
      .fn()
      .mockRejectedValueOnce(new Error('tab closed after request started'))
      .mockImplementationOnce(async (_folder, _name, content) => {
        uploadedContent = content
        return {
          uri: 'https://drive.google.com/file/d/reserved123/view',
          name: 'reserved.json',
        }
      })
    const generateFileId = vi.fn().mockResolvedValue('reserved123')
    const getMetadataIfExists = vi.fn().mockResolvedValue(null)
    appState.setDriveNotebookStore({
      generateFileId,
      getMetadataIfExists,
      findByCreateOperation: vi.fn().mockResolvedValue(null),
      createContent,
      getVersionMetadata: vi.fn().mockImplementation(async () => ({
        md5Checksum: md5(uploadedContent),
        headRevisionId: 'reserved-revision',
        appProperties: {
          runmeCreateCompletedChecksum: md5(uploadedContent),
        },
      })),
      loadContent: vi.fn().mockImplementation(async () => uploadedContent),
    } as any)
    appState.setLocalNotebooks({
      addFile: vi.fn().mockResolvedValue('local://file/reserved'),
      initializeUploadedDriveNotebook: vi.fn().mockResolvedValue(true),
    } as any)
    appState.setOpenNotebookHandler(vi.fn().mockResolvedValue(undefined))
    const createOnce = () =>
      createDriveNotebook('folder123', 'reserved.json', {
        idempotencyKey: 'reserved-operation',
      })

    await expect(createOnce()).rejects.toThrow('tab closed')
    await expect(createOnce()).resolves.toMatchObject({
      fileId: 'reserved123',
    })

    expect(generateFileId).toHaveBeenCalledTimes(1)
    expect(getMetadataIfExists).toHaveBeenCalledWith(
      'https://drive.google.com/file/d/reserved123/view'
    )
    expect(createContent).toHaveBeenCalledTimes(2)
    expect(createContent.mock.calls[0]?.[4]).toMatchObject({
      fileId: 'reserved123',
    })
    expect(createContent.mock.calls[1]?.[4]).toMatchObject({
      fileId: 'reserved123',
    })
  })

  it('attaches an adopted notebook to its current Drive parent after a move', async () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    })
    const notebook = create(parser_pb.NotebookSchema, { cells: [] })
    const content = encodeRunmeNotebook(notebook)
    const checksum = md5(content)
    const remoteUri = 'https://drive.google.com/file/d/moved123/view'
    const originalParent = 'https://drive.google.com/drive/folders/folder123'
    const movedParent = 'https://drive.google.com/drive/folders/folder456'
    const getMetadataIfExists = vi.fn().mockResolvedValue({
      uri: remoteUri,
      name: 'moved.json',
      parents: [movedParent],
    })
    const createContent = vi.fn().mockResolvedValue({
      uri: remoteUri,
      name: 'moved.json',
      parents: [originalParent],
    })
    appState.setDriveNotebookStore({
      generateFileId: vi.fn().mockResolvedValue('moved123'),
      getMetadataIfExists,
      findByCreateOperation: vi.fn().mockResolvedValue(null),
      createContent,
      getVersionMetadata: vi.fn().mockResolvedValue({
        md5Checksum: checksum,
        appProperties: {
          runmeCreateCompletedChecksum: checksum,
        },
      }),
      loadContent: vi.fn().mockResolvedValue(content),
    } as any)
    const attachDriveFileToFolder = vi
      .fn()
      .mockResolvedValue('local://folder/moved')
    appState.setLocalNotebooks({
      addFile: vi.fn().mockResolvedValue('local://file/moved'),
      attachDriveFileToFolder,
      initializeUploadedDriveNotebook: vi.fn().mockResolvedValue(true),
    } as any)
    appState.setOpenNotebookHandler(
      vi
        .fn()
        .mockRejectedValueOnce(new Error('tab failed after create'))
        .mockResolvedValueOnce(undefined)
    )

    const createOnce = () =>
      createDriveNotebook('folder123', 'moved.json', {
        idempotencyKey: 'moved-operation',
      })
    await expect(createOnce()).rejects.toThrow('tab failed after create')
    await expect(createOnce()).resolves.toMatchObject({ fileId: 'moved123' })

    expect(createContent).toHaveBeenCalledTimes(1)
    expect(attachDriveFileToFolder).toHaveBeenLastCalledWith(
      movedParent,
      'local://file/moved'
    )
  })

  it('attaches an adopted notebook to the canonical My Drive root', async () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    })
    const notebook = create(parser_pb.NotebookSchema, { cells: [] })
    const content = encodeRunmeNotebook(notebook)
    const checksum = md5(content)
    const remoteUri = 'https://drive.google.com/file/d/rooted123/view'
    const originalParent = 'https://drive.google.com/drive/folders/folder123'
    const createContent = vi.fn().mockResolvedValue({
      uri: remoteUri,
      name: 'rooted.json',
      parents: [originalParent],
    })
    appState.setDriveNotebookStore({
      generateFileId: vi.fn().mockResolvedValue('rooted123'),
      getMetadataIfExists: vi.fn().mockResolvedValue({
        uri: remoteUri,
        name: 'rooted.json',
        parents: ['root'],
      }),
      findByCreateOperation: vi.fn().mockResolvedValue(null),
      createContent,
      getVersionMetadata: vi.fn().mockResolvedValue({
        md5Checksum: checksum,
        appProperties: {
          runmeCreateCompletedChecksum: checksum,
        },
      }),
      loadContent: vi.fn().mockResolvedValue(content),
    } as any)
    const attachDriveFileToFolder = vi.fn().mockResolvedValue('local://root')
    appState.setLocalNotebooks({
      addFile: vi.fn().mockResolvedValue('local://file/rooted'),
      attachDriveFileToFolder,
      initializeUploadedDriveNotebook: vi.fn().mockResolvedValue(true),
    } as any)
    appState.setOpenNotebookHandler(
      vi
        .fn()
        .mockRejectedValueOnce(new Error('tab failed after create'))
        .mockResolvedValueOnce(undefined)
    )

    const createOnce = () =>
      createDriveNotebook('folder123', 'rooted.json', {
        idempotencyKey: 'rooted-operation',
      })
    await expect(createOnce()).rejects.toThrow('tab failed after create')
    await expect(createOnce()).resolves.toMatchObject({ fileId: 'rooted123' })

    expect(createContent).toHaveBeenCalledTimes(1)
    expect(attachDriveFileToFolder).toHaveBeenLastCalledWith(
      'https://drive.google.com/drive/folders/root',
      'local://file/rooted'
    )
  })

  it('rejects an adopted Drive file created for a different requested name', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: vi.fn(),
    })
    const createContent = vi.fn()
    appState.setDriveNotebookStore({
      findByCreateOperation: vi.fn().mockResolvedValue({
        uri: 'https://drive.google.com/file/d/existing123/view',
        name: 'original.json',
      }),
      createContent,
      getVersionMetadata: vi.fn().mockResolvedValue({
        appProperties: {
          runmeCreateExpectedRequest: 'fingerprint-for-original-name',
        },
      }),
    } as any)

    await expect(
      createDriveNotebook('folder123', 'different.json', {
        idempotencyKey: 'same-cross-browser-operation',
      })
    ).rejects.toThrow('different notebook input')
    expect(createContent).not.toHaveBeenCalled()
  })

  it('does not create when durable retry state cannot be persisted', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('storage blocked')
      },
    })
    const createContent = vi.fn()
    appState.setDriveNotebookStore({
      findByCreateOperation: vi.fn().mockResolvedValue(null),
      createContent,
    } as any)

    await expect(
      createDriveNotebook('folder123', 'safe.json', {
        idempotencyKey: 'storage-required',
      })
    ).rejects.toThrow('browser storage is required')
    expect(createContent).not.toHaveBeenCalled()
  })

  it('waits for an ambiguously created Drive file to become searchable', async () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    })
    const remoteFile = {
      uri: 'https://drive.google.com/file/d/eventual123/view',
      name: 'eventual.json',
    }
    let remoteContent = ''
    const findByCreateOperation = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(remoteFile)
    const createContent = vi
      .fn()
      .mockImplementation(async (_folder, _name, content) => {
        remoteContent = content
        throw new Error('response lost after Drive committed the file')
      })
    appState.setDriveNotebookStore({
      findByCreateOperation,
      createContent,
      getVersionMetadata: vi.fn().mockImplementation(async () => ({
        md5Checksum: md5(remoteContent),
        headRevisionId: 'eventual-revision',
        appProperties: {
          runmeCreateCompletedChecksum: md5(remoteContent),
        },
      })),
      loadContent: vi.fn().mockImplementation(async () => remoteContent),
    } as any)
    appState.setLocalNotebooks({
      addFile: vi.fn().mockResolvedValue('local://file/eventual'),
      initializeUploadedDriveNotebook: vi.fn().mockResolvedValue(true),
    } as any)
    appState.setOpenNotebookHandler(vi.fn().mockResolvedValue(undefined))
    const createOnce = () =>
      createDriveNotebook('folder123', 'eventual.json', {
        idempotencyKey: 'eventual-operation',
      })

    await expect(createOnce()).rejects.toThrow('response lost')
    await expect(createOnce()).resolves.toMatchObject({
      fileId: 'eventual123',
    })
    expect(createContent).toHaveBeenCalledTimes(1)
    expect(findByCreateOperation).toHaveBeenCalledTimes(3)
  })

  it('serializes overlapping creation calls that use the same key', async () => {
    let uploadedContent = ''
    let releaseCreate!: () => void
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    const findByCreateOperation = vi.fn().mockResolvedValue(null)
    const createContent = vi
      .fn()
      .mockImplementation(async (_folder, _name, content) => {
        uploadedContent = content
        await createGate
        return {
          uri: 'https://drive.google.com/file/d/serialized123/view',
          name: 'serialized.json',
        }
      })
    const getVersionMetadata = vi.fn().mockImplementation(async () => ({
      md5Checksum: md5(uploadedContent),
      headRevisionId: 'serialized-revision',
    }))
    appState.setDriveNotebookStore({
      findByCreateOperation,
      createContent,
      getVersionMetadata,
      loadContent: vi.fn().mockImplementation(async () => uploadedContent),
      markCreateOperationComplete: vi.fn().mockResolvedValue(undefined),
    } as any)
    appState.setLocalNotebooks({
      addFile: vi.fn().mockResolvedValue('local://file/serialized'),
      initializeUploadedDriveNotebook: vi.fn().mockResolvedValue(true),
    } as any)
    const openNotebook = vi.fn().mockResolvedValue(undefined)
    appState.setOpenNotebookHandler(openNotebook)

    const createOnce = () =>
      createDriveNotebook('folder123', 'serialized.json', {
        idempotencyKey: 'same-operation',
      })
    const first = createOnce()
    await vi.waitFor(() => expect(createContent).toHaveBeenCalledTimes(1))
    const second = createDriveNotebook(
      'https://drive.google.com/drive/folders/folder123?usp=drive_link',
      'serialized.json',
      { idempotencyKey: 'same-operation' }
    )
    releaseCreate()

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(secondResult).toEqual(firstResult)
    expect(findByCreateOperation).toHaveBeenCalledTimes(1)
    expect(createContent).toHaveBeenCalledTimes(1)
    expect(openNotebook).toHaveBeenCalledTimes(1)
  })

  it('guards idempotent creation with a cross-context Web Lock', async () => {
    let uploadedContent = ''
    const request = vi.fn(
      async (_name: string, operation: () => Promise<unknown>) => operation()
    )
    vi.stubGlobal('navigator', { locks: { request } })
    const createContent = vi
      .fn()
      .mockImplementation(async (_folder, _name, content) => {
        uploadedContent = content
        return {
          uri: 'https://drive.google.com/file/d/locked123/view',
          name: 'locked.json',
        }
      })
    appState.setDriveNotebookStore({
      findByCreateOperation: vi.fn().mockResolvedValue(null),
      createContent,
      getVersionMetadata: vi.fn().mockImplementation(async () => ({
        md5Checksum: md5(uploadedContent),
        headRevisionId: 'locked-revision',
      })),
      loadContent: vi.fn().mockImplementation(async () => uploadedContent),
      markCreateOperationComplete: vi.fn().mockResolvedValue(undefined),
    } as any)
    appState.setLocalNotebooks({
      addFile: vi.fn().mockResolvedValue('local://file/locked'),
      initializeUploadedDriveNotebook: vi.fn().mockResolvedValue(true),
    } as any)
    appState.setOpenNotebookHandler(vi.fn().mockResolvedValue(undefined))

    await createDriveNotebook('folder123', 'locked.json', {
      idempotencyKey: 'cross-context-operation',
    })

    expect(request).toHaveBeenCalledWith(
      expect.stringMatching(
        /^runme:drive-sync:create:https:\/\/drive\.google\.com\/drive\/folders\/folder123:[a-f0-9]{64}$/
      ),
      expect.any(Function)
    )
    expect(createContent).toHaveBeenCalledTimes(1)
  })

  it('rejects a direct Drive notebook name that the explorer cannot reopen', async () => {
    await expect(
      createDriveNotebook('folder123', 'hidden-notebook', {
        idempotencyKey: 'unsupported-extension',
      })
    ).rejects.toThrow('must end in .json or .ipynb')
  })

  it('mirrors a concurrent Drive edit instead of assigning it to the uploaded baseline', async () => {
    const remoteNotebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          refId: 'external-edit',
          kind: parser_pb.CellKind.MARKUP,
          languageId: 'markdown',
          value: '# Edited elsewhere',
        }),
      ],
    })
    const remoteContent = encodeRunmeNotebook(remoteNotebook)
    const remoteChecksum = md5(remoteContent)
    const createContent = vi.fn().mockResolvedValue({
      uri: 'https://drive.google.com/file/d/drive123/view',
      name: 'concurrent.json',
    })
    const getVersionMetadata = vi.fn().mockResolvedValue({
      md5Checksum: remoteChecksum,
      headRevisionId: 'external-revision',
    })
    const loadContent = vi.fn().mockResolvedValue(remoteContent)
    appState.setDriveNotebookStore({
      createContent,
      getVersionMetadata,
      loadContent,
    } as any)
    const initializeUploadedDriveNotebook = vi.fn().mockResolvedValue(true)
    appState.setLocalNotebooks({
      addFile: vi.fn().mockResolvedValue('local://file/drive-mirror'),
      initializeUploadedDriveNotebook,
    } as any)
    appState.setOpenNotebookHandler(vi.fn().mockResolvedValue(undefined))

    await saveNotebookAsDriveCopy(
      create(parser_pb.NotebookSchema, { cells: [] }),
      'folder123',
      'concurrent.json'
    )

    expect(initializeUploadedDriveNotebook).toHaveBeenCalledWith(
      'local://file/drive-mirror',
      expect.objectContaining({
        cells: [expect.objectContaining({ value: '# Edited elsewhere' })],
      }),
      remoteContent,
      {
        checksum: remoteChecksum,
        revisionId: 'external-revision',
      }
    )
  })

  it('uses the ipynb extension to save a Jupyter notebook', async () => {
    let uploadedContent = ''
    const createContent = vi
      .fn()
      .mockImplementation(async (_folder, _name, content) => {
        uploadedContent = content
        return {
          uri: 'https://drive.google.com/file/d/drive123/view',
          name: 'copy.ipynb',
        }
      })
    const getVersionMetadata = vi.fn().mockImplementation(async () => ({
      md5Checksum: md5(uploadedContent),
      headRevisionId: 'drive-revision-1',
    }))
    appState.setDriveNotebookStore({
      createContent,
      getVersionMetadata,
    } as any)
    appState.setLocalNotebooks({
      addFile: vi.fn().mockResolvedValue('local://file/new-copy'),
      initializeUploadedDriveNotebook: vi.fn().mockResolvedValue(true),
    } as any)
    appState.setOpenNotebookHandler(vi.fn().mockResolvedValue(undefined))

    await saveNotebookAsDriveCopy(
      create(parser_pb.NotebookSchema, { cells: [] }),
      'folder123',
      'copy.ipynb'
    )

    const [, , content, mimeType] = createContent.mock.calls[0]
    expect(mimeType).toBe('application/x-ipynb+json')
    expect(JSON.parse(content)).toMatchObject({
      cells: [],
      nbformat: 4,
      nbformat_minor: 5,
    })
  })
})
