// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NotebookStoreItemType } from '../../storage/notebook'
import { DriveCreateNotCommittedError } from '../../storage/drive'
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
  ensureAccessToken: vi.fn(),
  store: {
    getMetadata: vi.fn(),
    create: vi.fn(),
    createContent: vi.fn(),
    createFolder: vi.fn(),
    move: vi.fn(),
    moveToTrash: vi.fn(),
    rename: vi.fn(),
    sync: vi.fn(),
  },
  openNotebookUpstreamDiff: vi.fn(),
  dragHandle: vi.fn(),
  treeEdit: vi.fn(),
  treeProps: null as any,
  workspaceItems: [] as string[],
}))

vi.mock('react-arborist', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  const Tree = React.forwardRef((props: any, ref) => {
    const { data, children, onToggle } = props
    mocks.treeProps = props
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
          isAncestorOf: vi.fn(() => false),
          reset: vi.fn(),
        }
        return (
          <div key={item.id}>
            {children({
              node,
              style: {},
              dragHandle: mocks.dragHandle,
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
    ensureAccessToken: mocks.ensureAccessToken,
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
  DriveCreateNotCommittedError: class extends Error {},
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
    mocks.ensureAccessToken.mockReset()
    mocks.ensureAccessToken.mockResolvedValue('access-token')
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
    mocks.store.create.mockReset()
    mocks.store.create.mockResolvedValue({
      uri: 'local://file/ipynb',
      name: 'untitled.ipynb',
      type: NotebookStoreItemType.File,
      children: [],
      remoteUri: undefined,
      mimeType: 'application/x-ipynb+json',
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
    mocks.store.move.mockReset()
    mocks.store.move.mockResolvedValue(undefined)
    mocks.store.rename.mockReset()
    mocks.store.rename.mockResolvedValue({
      uri: 'local://file/renamed',
      name: 'renamed.json',
      type: NotebookStoreItemType.File,
      children: [],
      parents: [],
    })
    mocks.store.sync.mockReset()
    mocks.openNotebookUpstreamDiff.mockReset()
    mocks.dragHandle.mockReset()
    mocks.openNotebookUpstreamDiff.mockResolvedValue(undefined)
    mocks.treeEdit.mockReset()
    mocks.treeEdit.mockResolvedValue(undefined)
    mocks.treeProps = null
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

  it('keeps an explicitly mounted nested folder visible as a root', async () => {
    mocks.workspaceItems = [
      'local://folder/local',
      'local://folder/root',
      'local://folder/nested',
    ]
    mocks.store.getMetadata.mockImplementation(async (uri: string) => {
      if (uri === 'local://folder/local') {
        return {
          uri,
          name: 'Local Notebooks',
          type: NotebookStoreItemType.Folder,
          children: [],
          parents: [],
        }
      }
      if (uri === 'local://folder/root') {
        return {
          uri,
          name: 'Mounted root',
          type: NotebookStoreItemType.Folder,
          children: ['local://folder/nested'],
          parents: [],
        }
      }
      if (uri === 'local://folder/nested') {
        return {
          uri,
          name: 'Nested mount',
          type: NotebookStoreItemType.Folder,
          children: [],
          parents: ['local://folder/root'],
        }
      }
      return null
    })

    render(<WorkspaceExplorer />)

    await screen.findByText('Mounted root')
    await screen.findByText('Nested mount')
    expect(screen.getAllByText('Nested mount')).toHaveLength(1)

    act(() => {
      mocks.treeProps.onToggle('local://folder/root')
    })
    await screen.findByText('Mounted folders are shown as roots')
    expect(screen.getAllByText('Nested mount')).toHaveLength(1)
  })

  it('shows a directly created Drive notebook in its mounted folder', async () => {
    mocks.workspaceItems = ['local://folder/drive']
    let blockFolderLoad = false
    let releaseFolderLoad!: () => void
    const folderLoadGate = new Promise<void>((resolve) => {
      releaseFolderLoad = resolve
    })
    const folderLoadStarted = vi.fn()
    mocks.store.getMetadata.mockImplementation(async (uri: string) => {
      if (uri === 'local://folder/drive') {
        if (blockFolderLoad) {
          folderLoadStarted()
          await folderLoadGate
        }
        return {
          uri,
          name: 'Drive Root',
          type: NotebookStoreItemType.Folder,
          children: [],
          remoteUri: 'https://drive.google.com/drive/folders/drive-root',
          parents: [],
        }
      }
      if (uri === 'local://file/direct') {
        return {
          uri,
          name: 'direct.ipynb',
          type: NotebookStoreItemType.File,
          children: [],
          remoteUri: 'https://drive.google.com/file/d/direct/view',
          parents: ['local://folder/drive'],
        }
      }
      if (uri === 'local://file/stale') {
        return {
          uri,
          name: 'stale.ipynb',
          type: NotebookStoreItemType.File,
          children: [],
          remoteUri: 'https://drive.google.com/file/d/stale/view',
          parents: ['local://folder/drive'],
        }
      }
      return null
    })

    render(<WorkspaceExplorer />)
    await screen.findByText('Drive Root')

    act(() => {
      window.dispatchEvent(
        new CustomEvent('local-notebook-updated', {
          detail: {
            uri: 'local://file/stale',
            parentUri: 'local://folder/drive',
          },
        })
      )
    })
    await screen.findByText('stale.ipynb')

    blockFolderLoad = true
    act(() => {
      mocks.treeProps.onToggle('local://folder/drive')
    })
    await waitFor(() => expect(folderLoadStarted).toHaveBeenCalled())

    act(() => {
      window.dispatchEvent(
        new CustomEvent('local-notebook-updated', {
          detail: {
            uri: 'local://file/direct',
            parentUri: 'local://folder/drive',
          },
        })
      )
    })

    await screen.findByText('direct.ipynb')
    await act(async () => {
      releaseFolderLoad()
      await folderLoadGate
    })
    expect(screen.getByText('direct.ipynb')).toBeTruthy()
    await waitFor(() => expect(screen.queryByText('stale.ipynb')).toBeNull())
    expect(screen.queryByText('Folder is empty')).toBeNull()
  })

  it('does not resurrect a removed child when an older folder load finishes', async () => {
    mocks.workspaceItems = ['local://folder/drive']
    let blockFolderLoad = false
    let releaseFolderLoad!: () => void
    const folderLoadGate = new Promise<void>((resolve) => {
      releaseFolderLoad = resolve
    })
    const folderLoadStarted = vi.fn()
    mocks.store.getMetadata.mockImplementation(async (uri: string) => {
      if (uri === 'local://folder/drive') {
        const children = blockFolderLoad ? ['local://file/direct'] : []
        if (blockFolderLoad) {
          folderLoadStarted()
          await folderLoadGate
        }
        return {
          uri,
          name: 'Drive Root',
          type: NotebookStoreItemType.Folder,
          children,
          remoteUri: 'https://drive.google.com/drive/folders/drive-root',
          parents: [],
        }
      }
      if (uri === 'local://file/direct') {
        return {
          uri,
          name: 'direct.ipynb',
          type: NotebookStoreItemType.File,
          children: [],
          remoteUri: 'https://drive.google.com/file/d/direct/view',
          parents: ['local://folder/drive'],
        }
      }
      return null
    })
    mocks.store.moveToTrash.mockImplementation(async () => {
      blockFolderLoad = false
    })

    render(<WorkspaceExplorer />)
    await screen.findByText('Drive Root')
    act(() => {
      window.dispatchEvent(
        new CustomEvent('local-notebook-updated', {
          detail: {
            uri: 'local://file/direct',
            parentUri: 'local://folder/drive',
          },
        })
      )
    })
    await screen.findByText('direct.ipynb')
    fireEvent.contextMenu(screen.getByText('direct.ipynb'))
    const trashButton = await screen.findByRole('button', {
      name: 'Move to Google Drive Trash',
    })

    blockFolderLoad = true
    act(() => {
      mocks.treeProps.onToggle('local://folder/drive')
    })
    await waitFor(() => expect(folderLoadStarted).toHaveBeenCalled())

    fireEvent.click(trashButton)
    await waitFor(() => {
      expect(mocks.store.moveToTrash).toHaveBeenCalledWith(
        'local://file/direct'
      )
    })
    await waitFor(() => expect(screen.queryByText('direct.ipynb')).toBeNull())

    await act(async () => {
      releaseFolderLoad()
      await folderLoadGate
    })
    expect(screen.queryByText('direct.ipynb')).toBeNull()
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

  it('creates a Jupyter notebook from a folder context menu', async () => {
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

    fireEvent.contextMenu(await screen.findByText('Drive Root'))
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'New Jupyter Notebook (.ipynb)',
      })
    )

    await waitFor(() => {
      expect(mocks.store.create).toHaveBeenCalledWith(
        'local://folder/drive',
        expect.stringMatching(/^untitled-\d{8}-\d{4}\.ipynb$/)
      )
    })
    await waitFor(() => {
      expect(mocks.treeEdit).toHaveBeenCalledWith('local://file/ipynb')
    })
  })

  it('shows Shared drive guidance when a service account cannot create a notebook', async () => {
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
    const message =
      "Google Drive cannot create this file because service accounts do not have storage quota. Choose a folder in a Shared drive. A folder shared from a user's My Drive is not a Shared drive."
    mocks.store.create.mockRejectedValueOnce(
      new DriveCreateNotCommittedError(message)
    )

    render(<WorkspaceExplorer />)

    fireEvent.contextMenu(await screen.findByText('Drive Root'))
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'New Jupyter Notebook (.ipynb)',
      })
    )

    expect(await screen.findByText(message)).toBeTruthy()
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

  it('authorizes interactively before renaming a Drive-backed notebook', async () => {
    mocks.currentDoc = 'local://file/current'
    mocks.isDriveItemUri.mockReturnValue(true)

    render(<WorkspaceExplorer />)

    await waitFor(() => expect(mocks.treeProps).toBeTruthy())
    await act(async () => {
      await mocks.treeProps.onRename({
        id: 'local://file/drive',
        name: 'renamed.json',
        node: {
          data: {
            uri: 'local://file/drive',
            name: 'original.json',
            type: NotebookStoreItemType.File,
            remoteUri: 'https://drive.google.com/file/d/file123/view',
          },
          parent: null,
          reset: vi.fn(),
        },
      })
    })

    expect(mocks.ensureAccessToken).toHaveBeenCalledWith({ interactive: true })
    expect(mocks.store.rename).toHaveBeenCalledWith(
      'local://file/drive',
      'renamed.json',
      'https://drive.google.com/file/d/file123/view'
    )
  })

  it('surfaces Drive authorization errors instead of silently resetting rename', async () => {
    const authorizationError =
      'Google Drive service-account authorization is required.'
    mocks.currentDoc = 'local://file/current'
    mocks.isDriveItemUri.mockReturnValue(true)
    mocks.ensureAccessToken.mockRejectedValueOnce(new Error(authorizationError))
    const reset = vi.fn()

    render(<WorkspaceExplorer />)

    await waitFor(() => expect(mocks.treeProps).toBeTruthy())
    await act(async () => {
      await mocks.treeProps.onRename({
        id: 'local://file/drive',
        name: 'renamed.json',
        node: {
          data: {
            uri: 'local://file/drive',
            name: 'original.json',
            type: NotebookStoreItemType.File,
            remoteUri: 'https://drive.google.com/file/d/file123/view',
          },
          parent: null,
          reset,
        },
      })
    })

    expect(mocks.store.rename).not.toHaveBeenCalled()
    expect(reset).toHaveBeenCalled()
    expect(
      await screen.findByText(
        `${authorizationError} Complete Google Drive authorization, then retry the rename.`
      )
    ).toBeTruthy()
  })

  it('surfaces a Drive rename response that did not apply the requested name', async () => {
    const renameError =
      'Google Drive returned success without applying the requested rename to "renamed.json".'
    mocks.currentDoc = 'local://file/current'
    mocks.isDriveItemUri.mockReturnValue(true)
    mocks.store.rename.mockRejectedValueOnce(new Error(renameError))
    const reset = vi.fn()

    render(<WorkspaceExplorer />)

    await waitFor(() => expect(mocks.treeProps).toBeTruthy())
    await act(async () => {
      await mocks.treeProps.onRename({
        id: 'local://file/drive',
        name: 'renamed.json',
        node: {
          data: {
            uri: 'local://file/drive',
            name: 'original.json',
            type: NotebookStoreItemType.File,
            remoteUri: 'https://drive.google.com/file/d/file123/view',
          },
          parent: null,
          reset,
        },
      })
    })

    expect(reset).toHaveBeenCalled()
    expect(await screen.findByText(renameError)).toBeTruthy()
  })

  it('validates a Drive rename before requesting authorization', async () => {
    mocks.currentDoc = 'local://file/current'
    mocks.isDriveItemUri.mockReturnValue(true)

    render(<WorkspaceExplorer />)

    await waitFor(() => expect(mocks.treeProps).toBeTruthy())
    await act(async () => {
      await mocks.treeProps.onRename({
        id: 'local://file/drive',
        name: 'renamed.ipynb',
        node: {
          data: {
            uri: 'local://file/drive',
            name: 'original.json',
            type: NotebookStoreItemType.File,
            remoteUri: 'https://drive.google.com/file/d/file123/view',
          },
          parent: null,
          reset: vi.fn(),
        },
      })
    })

    expect(mocks.ensureAccessToken).not.toHaveBeenCalled()
    expect(mocks.store.rename).not.toHaveBeenCalled()
    expect(
      await screen.findByText(
        'Changing notebook formats by rename is not supported. Use Save as instead.'
      )
    ).toBeTruthy()
  })

  it('renames a local notebook without requesting Drive authorization', async () => {
    mocks.currentDoc = 'local://file/current'
    render(<WorkspaceExplorer />)

    await waitFor(() => expect(mocks.treeProps).toBeTruthy())
    await act(async () => {
      await mocks.treeProps.onRename({
        id: 'local://file/local',
        name: 'renamed.json',
        node: {
          data: {
            uri: 'local://file/local',
            name: 'original.json',
            type: NotebookStoreItemType.File,
          },
          parent: null,
          reset: vi.fn(),
        },
      })
    })

    expect(mocks.ensureAccessToken).not.toHaveBeenCalled()
    expect(mocks.store.rename).toHaveBeenCalledWith(
      'local://file/local',
      'renamed.json'
    )
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

  it('moves a Drive-backed file into a Drive folder via the tree move handler', async () => {
    mocks.workspaceItems = ['local://folder/drive']
    mocks.store.getMetadata.mockImplementation(async (uri: string) => {
      if (uri === 'local://folder/drive') {
        return {
          uri,
          name: 'Drive Root',
          type: NotebookStoreItemType.Folder,
          children: ['local://file/notebook', 'local://folder/reports'],
          remoteUri: 'https://drive.google.com/drive/folders/drive-root',
          parents: [],
        }
      }
      if (uri === 'local://file/notebook') {
        return {
          uri,
          name: 'notebook.json',
          type: NotebookStoreItemType.File,
          children: [],
          remoteUri: 'https://drive.google.com/file/d/file123/view',
          parents: ['local://folder/drive'],
        }
      }
      if (uri === 'local://folder/reports') {
        return {
          uri,
          name: 'Reports',
          type: NotebookStoreItemType.Folder,
          children: [],
          remoteUri: 'https://drive.google.com/drive/folders/reports123',
          parents: ['local://folder/drive'],
        }
      }
      return null
    })

    render(<WorkspaceExplorer />)
    await screen.findByText('Drive Root')

    fireEvent.click(screen.getAllByRole('button', { name: 'Collapse folder' })[0])
    await screen.findByText('notebook.json')

    expect(
      mocks.dragHandle.mock.calls.some(
        ([element]) =>
          element instanceof HTMLElement &&
          element.dataset.nodeId === 'local://file/notebook'
      )
    ).toBe(true)

    const dragNode = {
      data: {
        id: 'local://file/notebook',
        uri: 'local://file/notebook',
        name: 'notebook.json',
        type: NotebookStoreItemType.File,
        remoteUri: 'https://drive.google.com/file/d/file123/view',
        parentUri: 'local://folder/drive',
      },
      isAncestorOf: vi.fn(() => false),
    }
    const destinationNode = {
      data: {
        id: 'local://folder/reports',
        uri: 'local://folder/reports',
        name: 'Reports',
        type: NotebookStoreItemType.Folder,
        remoteUri: 'https://drive.google.com/drive/folders/reports123',
        parentUri: 'local://folder/drive',
      },
    }

    expect(mocks.treeProps.disableDrag(dragNode.data)).toBe(false)
    expect(
      mocks.treeProps.disableDrop({
        parentNode: null,
        dragNodes: [dragNode],
        index: 0,
      })
    ).toBe(true)
    expect(
      mocks.treeProps.disableDrop({
        parentNode: destinationNode,
        dragNodes: [dragNode],
        index: 0,
      })
    ).toBe(false)

    await act(async () => {
      await mocks.treeProps.onMove({
        dragIds: ['local://file/notebook'],
        dragNodes: [dragNode],
        parentId: 'local://folder/reports',
        parentNode: destinationNode,
        index: 0,
      })
    })

    expect(mocks.store.move).toHaveBeenCalledWith(
      'local://file/notebook',
      'local://folder/reports'
    )
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
