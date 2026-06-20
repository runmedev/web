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
    createContent: vi.fn(),
    createFolder: vi.fn(),
    moveToTrash: vi.fn(),
    sync: vi.fn(),
  },
  openNotebookUpstreamDiff: vi.fn(),
  treeEdit: vi.fn(),
  workspaceItems: [] as string[],
}))

vi.mock('react-arborist', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  const Tree = React.forwardRef(({ data, children, onToggle }: any, ref) => {
    React.useImperativeHandle(ref, () => ({
      get: (id: string) => ({
        data: { uri: id, type: 'folder' },
        isOpen: true,
        openParents: vi.fn(),
        parent: { open: vi.fn() },
      }),
      open: vi.fn(),
      edit: mocks.treeEdit,
    }))

    const renderItems = (items: any[], parent: any = null): React.ReactNode =>
      (items ?? []).map((item: any) => {
        const node = {
          data: item,
          isEditing: false,
          isOpen: true,
          handleClick: vi.fn(),
          toggle: vi.fn(() => onToggle?.(item.id)),
          parent,
          reset: vi.fn(),
        }
        return (
          <div key={item.id}>
            {children({
              node,
              style: {},
            })}
            {item.children?.length ? renderItems(item.children, node) : null}
          </div>
        )
      })

    return <div data-testid="tree">{renderItems(data ?? [])}</div>
  })
  Tree.displayName = 'MockTree'
  return { Tree }
})

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

vi.mock('../../lib/notebookDiff/conflict', () => ({
  openNotebookUpstreamDiff: mocks.openNotebookUpstreamDiff,
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
    mocks.store.createContent.mockReset()
    mocks.store.createContent.mockResolvedValue({
      uri: 'local://file/excalidraw',
      name: 'untitled-20260616-1200.excalidraw',
      type: NotebookStoreItemType.File,
      children: [],
      remoteUri: undefined,
      mimeType: 'application/vnd.excalidraw+json',
      parents: ['local://folder/drive'],
    })
    mocks.store.moveToTrash.mockReset()
    mocks.store.moveToTrash.mockResolvedValue(undefined)
    mocks.store.sync.mockReset()
    mocks.openNotebookUpstreamDiff.mockReset()
    mocks.openNotebookUpstreamDiff.mockResolvedValue(undefined)
    mocks.treeEdit.mockReset()
    mocks.treeEdit.mockResolvedValue(undefined)
    vi.spyOn(window, 'prompt').mockReturnValue('Reports')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
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

  it('creates a Google Drive folder inline from a Drive-backed folder context menu', async () => {
    mocks.workspaceItems = ['local://folder/drive']
    mocks.store.getMetadata.mockImplementation(async (uri: string) => {
      if (uri === 'local://folder/drive') {
        return {
          uri,
          name: 'Drive Root',
          type: NotebookStoreItemType.Folder,
          children: mocks.store.createFolder.mock.calls.length
            ? ['local://folder/new']
            : [],
          remoteUri: 'https://drive.google.com/drive/folders/drive-root',
          parents: [],
        }
      }
      if (uri === 'local://folder/new') {
        return {
          uri,
          name: 'New Folder',
          type: NotebookStoreItemType.Folder,
          children: [],
          remoteUri: 'https://drive.google.com/drive/folders/new',
          parents: ['local://folder/drive'],
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
        'New Folder'
      )
    })
    expect(window.prompt).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(mocks.treeEdit).toHaveBeenCalledWith('local://folder/new')
    })
  })

  it('starts inline rename from a Drive-backed folder context menu', async () => {
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
        name: 'Rename',
      })
    )

    await waitFor(() => {
      expect(mocks.treeEdit).toHaveBeenCalledWith('local://folder/drive')
    })
  })

  it('creates an Excalidraw diagram through the local mirror before Drive sync', async () => {
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
        name: 'New Excalidraw Diagram',
      })
    )

    await waitFor(() => {
      expect(mocks.store.createContent).toHaveBeenCalledWith(
        'local://folder/drive',
        expect.stringMatching(/^untitled-\d{8}-\d{4}\.excalidraw$/),
        expect.stringMatching(/"type":\s*"excalidraw"/),
        'application/vnd.excalidraw+json'
      )
    })
    expect(mocks.showDocument).not.toHaveBeenCalled()
    expect(mocks.setCurrentDoc).not.toHaveBeenCalledWith(
      'local://file/excalidraw'
    )
  })

  it('opens a pending local Excalidraw diagram before the Drive URI is available', async () => {
    mocks.workspaceItems = ['local://folder/drive']
    mocks.store.getMetadata.mockImplementation(async (uri: string) => {
      if (uri === 'local://folder/drive') {
        return {
          uri,
          name: 'Drive Root',
          type: NotebookStoreItemType.Folder,
          children: ['local://file/excalidraw'],
          remoteUri: 'https://drive.google.com/drive/folders/drive-root',
          parents: [],
        }
      }
      if (uri === 'local://file/excalidraw') {
        return {
          uri,
          name: 'diagram.excalidraw',
          type: NotebookStoreItemType.File,
          children: [],
          remoteUri: undefined,
          mimeType: 'application/vnd.excalidraw+json',
          parents: ['local://folder/drive'],
        }
      }
      return null
    })

    render(<WorkspaceExplorer />)

    await screen.findByText('Drive Root')
    fireEvent.click(screen.getAllByRole('button', { name: 'Collapse folder' })[0])
    fireEvent.click(await screen.findByText('diagram.excalidraw'))

    await waitFor(() => {
      expect(mocks.showDocument).toHaveBeenCalledWith(
        'local://file/excalidraw',
        {
          title: 'diagram.excalidraw',
          requestedUri: undefined,
          mimeType: 'application/vnd.excalidraw+json',
        }
      )
    })
    expect(mocks.setCurrentDoc).toHaveBeenCalledWith('local://file/excalidraw')
  })

  it('moves a Drive-backed file to Google Drive trash from the context menu after confirmation', async () => {
    mocks.workspaceItems = ['local://folder/drive']
    mocks.store.getMetadata.mockImplementation(async (uri: string) => {
      if (uri === 'local://folder/drive') {
        return {
          uri,
          name: 'Drive Root',
          type: NotebookStoreItemType.Folder,
          children: ['local://file/untitled'],
          remoteUri: 'https://drive.google.com/drive/folders/drive-root',
          parents: [],
        }
      }
      if (uri === 'local://file/untitled') {
        return {
          uri,
          name: 'untitled.json',
          type: NotebookStoreItemType.File,
          children: [],
          remoteUri: 'https://drive.google.com/file/d/file123/view',
          parents: ['local://folder/drive'],
        }
      }
      return null
    })

    render(<WorkspaceExplorer />)

    await screen.findByText('Drive Root')
    fireEvent.click(screen.getAllByRole('button', { name: 'Collapse folder' })[0])
    await waitFor(() => {
      expect(screen.getByText('untitled.json')).toBeTruthy()
    })

    fireEvent.contextMenu(screen.getByText('untitled.json'))
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Move to Google Drive Trash',
      })
    )

    expect(window.confirm).toHaveBeenCalledWith(
      'Move "untitled.json" to Google Drive trash? You can restore it from Google Drive trash.'
    )
    await waitFor(() => {
      expect(mocks.store.moveToTrash).toHaveBeenCalledWith(
        'local://file/untitled'
      )
    })
  })

  it('opens an upstream diff from a Drive-backed file context menu', async () => {
    mocks.workspaceItems = ['local://folder/drive']
    mocks.store.getMetadata.mockImplementation(async (uri: string) => {
      if (uri === 'local://folder/drive') {
        return {
          uri,
          name: 'Drive Root',
          type: NotebookStoreItemType.Folder,
          children: ['local://file/untitled'],
          remoteUri: 'https://drive.google.com/drive/folders/drive-root',
          parents: [],
        }
      }
      if (uri === 'local://file/untitled') {
        return {
          uri,
          name: 'untitled.json',
          type: NotebookStoreItemType.File,
          children: [],
          remoteUri: 'https://drive.google.com/file/d/file123/view',
          parents: ['local://folder/drive'],
        }
      }
      return null
    })

    render(<WorkspaceExplorer />)

    await screen.findByText('Drive Root')
    fireEvent.click(screen.getAllByRole('button', { name: 'Collapse folder' })[0])
    await waitFor(() => {
      expect(screen.getByText('untitled.json')).toBeTruthy()
    })

    fireEvent.contextMenu(screen.getByText('untitled.json'))
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Compare with upstream',
      })
    )

    await waitFor(() => {
      expect(mocks.openNotebookUpstreamDiff).toHaveBeenCalledWith(
        mocks.store,
        'local://file/untitled'
      )
    })
  })
})
