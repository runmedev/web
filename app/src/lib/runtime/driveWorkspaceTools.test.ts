import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildListDriveFolderInputSchema,
  buildMountDriveFolderInputSchema,
  buildSearchDriveItemsInputSchema,
  executeListDriveFolder,
  executeMountDriveFolder,
  executeSearchDriveItems,
} from './driveWorkspaceTools'

const { mountDriveFolderMock, searchDriveFilesMock } = vi.hoisted(() => ({
  mountDriveFolderMock: vi.fn(),
  searchDriveFilesMock: vi.fn(),
}))

vi.mock('../driveTransfer', () => ({
  mountDriveFolder: mountDriveFolderMock,
  searchDriveFiles: searchDriveFilesMock,
}))

describe('driveWorkspaceTools', () => {
  beforeEach(() => {
    mountDriveFolderMock.mockReset()
    searchDriveFilesMock.mockReset()
    searchDriveFilesMock.mockResolvedValue({ files: [] })
  })

  it('publishes bounded, strict input schemas', () => {
    expect(buildSearchDriveItemsInputSchema()).toMatchObject({
      additionalProperties: false,
      required: ['name'],
      properties: {
        itemType: { enum: ['any', 'file', 'folder'] },
        pageSize: { minimum: 1, maximum: 100 },
      },
    })
    expect(buildListDriveFolderInputSchema()).toMatchObject({
      additionalProperties: false,
      required: ['folderIdOrUri'],
      properties: {
        pageSize: { minimum: 1, maximum: 100 },
      },
    })
    expect(buildMountDriveFolderInputSchema()).toMatchObject({
      additionalProperties: false,
      required: ['folderIdOrUri'],
    })
  })

  it('searches exact folder names across My Drive and shared drives', async () => {
    await executeSearchDriveItems({
      name: 'notebooks',
      itemType: 'folder',
      exactName: true,
      pageSize: 10,
    })

    expect(searchDriveFilesMock).toHaveBeenCalledWith({
      q: "name = 'notebooks' and trashed = false and mimeType = 'application/vnd.google-apps.folder'",
      spaces: 'drive',
      orderBy: 'modifiedTime desc,name',
      pageSize: 10,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields:
        'nextPageToken,incompleteSearch,files(id,name,mimeType,parents,driveId,createdTime,modifiedTime,webViewLink)',
    })
  })

  it('escapes query text and scopes searches to a parent folder', async () => {
    await executeSearchDriveItems({
      name: "team's \\ notebooks",
      parentFolderIdOrUri: 'https://drive.google.com/drive/folders/parent-123',
      pageToken: 'next-page',
    })

    expect(searchDriveFilesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        q: "name contains 'team\\'s \\\\ notebooks' and trashed = false and 'parent-123' in parents",
        pageSize: 25,
        pageToken: 'next-page',
      })
    )
  })

  it('rejects empty search names', async () => {
    await expect(executeSearchDriveItems({ name: ' ' })).rejects.toThrow(
      'searchDriveItems requires a non-empty name'
    )
  })

  it('rejects invalid query and pagination controls at execution time', async () => {
    await expect(
      executeSearchDriveItems({ name: 'notebooks', itemType: 'directory' })
    ).rejects.toThrow('itemType must be any, file, or folder')
    await expect(
      executeSearchDriveItems({ name: 'notebooks', exactName: 'yes' })
    ).rejects.toThrow('exactName must be a boolean')
    await expect(
      executeSearchDriveItems({ name: 'notebooks', pageSize: 101 })
    ).rejects.toThrow('pageSize must be an integer between 1 and 100')
    await expect(
      executeSearchDriveItems({ name: 'notebooks', pageToken: 42 })
    ).rejects.toThrow('pageToken must be a string')
  })

  it('lists one bounded page from a canonical folder', async () => {
    searchDriveFilesMock.mockResolvedValue({
      files: [{ id: 'child-1', name: 'Child' }],
      nextPageToken: 'next-page',
    })

    const result = JSON.parse(
      await executeListDriveFolder({
        folderIdOrUri: 'folder-123',
        pageSize: 5,
      })
    )

    expect(searchDriveFilesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        q: "'folder-123' in parents and trashed = false",
        orderBy: 'name',
        pageSize: 5,
      })
    )
    expect(result).toMatchObject({
      folderUri: 'https://drive.google.com/drive/folders/folder-123',
      nextPageToken: 'next-page',
    })
  })

  it('mounts only canonical folder references', async () => {
    mountDriveFolderMock.mockResolvedValue({
      folderId: 'folder-123',
      name: 'notebooks',
      remoteUri: 'https://drive.google.com/drive/folders/folder-123',
      localUri: 'local://folder/folder-123',
      alreadyMounted: false,
    })

    const result = JSON.parse(
      await executeMountDriveFolder({ folderIdOrUri: 'folder-123' })
    )

    expect(mountDriveFolderMock).toHaveBeenCalledWith(
      'https://drive.google.com/drive/folders/folder-123'
    )
    expect(result.name).toBe('notebooks')
  })

  it('rejects file URLs where a folder is required', async () => {
    await expect(
      executeMountDriveFolder({
        folderIdOrUri: 'https://drive.google.com/file/d/file-123/view',
      })
    ).rejects.toThrow(
      'mountDriveFolder requires a Google Drive folder ID or URI'
    )
  })
})
