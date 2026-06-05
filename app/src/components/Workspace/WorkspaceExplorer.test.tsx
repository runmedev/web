// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NotebookStoreItemType } from '../../storage/notebook'
import { WorkspaceExplorer } from './WorkspaceExplorer'

const mocks = vi.hoisted(() => ({
  currentDoc: 'diff://notebook/diff-1',
  setCurrentDoc: vi.fn(),
  fetchDriveItemWithParents: vi.fn(),
  parseDriveItem: vi.fn(),
  isDriveItemUri: vi.fn(),
  openNotebook: vi.fn(),
  showDocument: vi.fn(),
  addItem: vi.fn(),
  removeItem: vi.fn(),
  store: {
    getMetadata: vi.fn(),
    createFolder: vi.fn(),
    sync: vi.fn(),
  },
  workspaceItems: [] as string[],
}))

vi.mock('react-arborist', () => ({
  Tree: ({ data, children }: any) => (
    <div data-testid="tree">
      {(data ?? []).map((item: any) => (
        <div key={item.id}>
          {children({
            node: {
              data: item,
              isEditing: false,
              isOpen: false,
              handleClick: vi.fn(),
              toggle: vi.fn(),
              parent: null,
            },
            style: {},
          })}
        </div>
      ))}
    </div>
  ),
}))

vi.mock('./GoogleDrivePickerButton', () => ({
  GoogleDrivePickerButton: () => <button type="button">Pick Drive</button>,
}))

vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({
    getItems: () => mocks.workspaceItems,
    addItem: mocks.addItem,
    removeItem: mocks.removeItem,
  }),
}))

vi.mock('../../contexts/NotebookStoreContext', () => ({
  useNotebookStore: () => ({
    store: mocks.store,
  }),
}))

vi.mock('../../contexts/FilesystemStoreContext', () => ({
  useFilesystemStore: () => ({
    fsStore: null,
  }),
}))

vi.mock('../../contexts/GoogleAuthContext', () => ({
  useGoogleAuth: () => ({
    ensureAccessToken: vi.fn(),
  }),
}))

vi.mock('../../contexts/CurrentDocContext', () => ({
  useCurrentDoc: () => ({
    getCurrentDoc: () => mocks.currentDoc,
    setCurrentDoc: mocks.setCurrentDoc,
  }),
}))

vi.mock('../../contexts/NotebookContext', () => ({
  useNotebookContext: () => ({
    openNotebook: mocks.openNotebook,
  }),
}))

vi.mock('../../contexts/WorkspaceDocumentContext', () => ({
  useWorkspaceDocumentContext: () => ({
    showDocument: mocks.showDocument,
  }),
}))

vi.mock('../../storage/drive', () => ({
  fetchDriveItemWithParents: mocks.fetchDriveItemWithParents,
  isDriveItemUri: mocks.isDriveItemUri,
  parseDriveItem: mocks.parseDriveItem,
}))

vi.mock('../../lib/toast', () => ({
  showToast: vi.fn(),
}))

describe('WorkspaceExplorer current document handling', () => {
  beforeEach(() => {
    mocks.currentDoc = 'diff://notebook/diff-1'
    mocks.setCurrentDoc.mockReset()
    mocks.fetchDriveItemWithParents.mockReset()
    mocks.fetchDriveItemWithParents.mockRejectedValue(
      new Error('auth required')
    )
    mocks.parseDriveItem.mockReset()
    mocks.parseDriveItem.mockReturnValue({
      id: 'diff-1',
      type: NotebookStoreItemType.File,
    })
    mocks.isDriveItemUri.mockReset()
    mocks.isDriveItemUri.mockReturnValue(false)
    mocks.openNotebook.mockReset()
    mocks.showDocument.mockReset()
    mocks.addItem.mockReset()
    mocks.removeItem.mockReset()
    mocks.workspaceItems = []
    mocks.store.getMetadata.mockReset()
    mocks.store.getMetadata.mockResolvedValue({
      uri: 'local://folder/local',
      name: 'Local Notebooks',
      type: NotebookStoreItemType.Folder,
      children: [],
      parents: [],
    })
    mocks.store.createFolder.mockReset()
    mocks.store.createFolder.mockResolvedValue({
      uri: 'local://folder/new',
      name: 'Reports',
      type: NotebookStoreItemType.Folder,
      children: [],
      remoteUri: 'https://drive.google.com/drive/folders/new',
      parents: ['local://folder/drive'],
    })
    mocks.store.sync.mockReset()
    vi.spyOn(window, 'prompt').mockReturnValue('Reports')
  })

  it('does not treat notebook diff URIs as Google Drive documents', async () => {
    render(<WorkspaceExplorer />)

    await waitFor(() => {
      expect(mocks.isDriveItemUri).toHaveBeenCalledWith(
        'diff://notebook/diff-1'
      )
    })
    expect(mocks.parseDriveItem).not.toHaveBeenCalled()
    expect(mocks.fetchDriveItemWithParents).not.toHaveBeenCalled()
    expect(mocks.setCurrentDoc).not.toHaveBeenCalledWith(null)
  })

  it('creates a Google Drive folder from a Drive-backed folder context menu', async () => {
    mocks.workspaceItems = ['local://folder/drive']
    mocks.store.getMetadata.mockImplementation(async (uri: string) => {
      if (uri === 'local://folder/drive') {
        return {
          uri,
          name: 'Drive Root',
          type: NotebookStoreItemType.Folder,
          children: [],
          remoteUri: 'https://drive.google.com/drive/folders/drive-root',
          parents: [],
        }
      }
      return null
    })

    render(<WorkspaceExplorer />)

    const driveRoot = await screen.findByText('Drive Root')
    fireEvent.contextMenu(driveRoot)
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'New Google Drive Folder',
      })
    )

    await waitFor(() => {
      expect(mocks.store.createFolder).toHaveBeenCalledWith(
        'local://folder/drive',
        'Reports'
      )
    })
  })
})
