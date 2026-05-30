// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react'
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
}))

vi.mock('react-arborist', () => ({
  Tree: () => <div data-testid="tree" />,
}))

vi.mock('./GoogleDrivePickerButton', () => ({
  GoogleDrivePickerButton: () => <button type="button">Pick Drive</button>,
}))

vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({
    getItems: () => [],
    addItem: vi.fn(),
    removeItem: vi.fn(),
  }),
}))

vi.mock('../../contexts/NotebookStoreContext', () => ({
  useNotebookStore: () => ({
    store: {},
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
})
