// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { tourUiController } from '../../lib/tourUiController'
import { GoogleDrivePickerButton } from './GoogleDrivePickerButton'

const mocks = vi.hoisted(() => ({
  addItem: vi.fn(),
  ensureAccessToken: vi.fn(),
  getItems: vi.fn(),
  listChildren: vi.fn(),
  listRoots: vi.fn(),
  startGoogleDriveOAuth: vi.fn(),
  updateFolder: vi.fn(),
}))

vi.mock('../../contexts/GoogleAuthContext', async () => {
  const actual = await vi.importActual<
    typeof import('../../contexts/GoogleAuthContext')
  >('../../contexts/GoogleAuthContext')
  return {
    ...actual,
    useGoogleAuth: () => ({
      ensureAccessToken: mocks.ensureAccessToken,
      startGoogleDriveOAuth: mocks.startGoogleDriveOAuth,
    }),
  }
})

vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({
    addItem: mocks.addItem,
    getItems: mocks.getItems,
  }),
}))

vi.mock('../../contexts/NotebookStoreContext', () => ({
  useNotebookStore: () => ({
    store: { updateFolder: mocks.updateFolder },
  }),
}))

vi.mock('../../lib/onboarding', () => ({
  markOnboardingTaskComplete: vi.fn(),
}))

vi.mock('./googleDriveBrowser', async () => {
  const actual = await vi.importActual<typeof import('./googleDriveBrowser')>(
    './googleDriveBrowser'
  )
  return {
    ...actual,
    listGoogleDriveChildren: mocks.listChildren,
    listGoogleDriveRoots: mocks.listRoots,
  }
})

describe('GoogleDrivePickerButton', () => {
  beforeEach(() => {
    tourUiController.resetForTests()
    mocks.addItem.mockReset()
    mocks.ensureAccessToken.mockReset()
    mocks.ensureAccessToken.mockResolvedValue('cached-access-token')
    mocks.getItems.mockReset()
    mocks.getItems.mockReturnValue([])
    mocks.listRoots.mockReset()
    mocks.listRoots.mockResolvedValue([
      { id: 'my-drive-root-id', name: 'My Drive' },
      { id: 'shared-drive-id', name: 'notebooks', driveId: 'shared-drive-id' },
    ])
    mocks.listChildren.mockReset()
    mocks.listChildren.mockResolvedValue([])
    mocks.startGoogleDriveOAuth.mockReset()
    mocks.updateFolder.mockReset()
  })

  afterEach(() => {
    tourUiController.resetForTests()
  })

  it("reuses the active token in Runme's Drive browser", async () => {
    render(<GoogleDrivePickerButton />)

    fireEvent.click(screen.getByRole('button', { name: 'Choose Folder' }))

    expect(
      await screen.findByRole('dialog', {
        name: 'Choose a Google Drive folder',
      })
    ).toBeTruthy()
    expect(mocks.ensureAccessToken).toHaveBeenCalledWith({ interactive: true })
    expect(mocks.listRoots).toHaveBeenCalledWith('cached-access-token')
    expect(mocks.startGoogleDriveOAuth).not.toHaveBeenCalled()
  })

  it('mounts a Shared Drive root and completes onboarding', async () => {
    mocks.updateFolder.mockResolvedValue('local://folder/shared-drive')
    const initialCount =
      tourUiController.getSnapshot().googleDriveFolderAddedCount

    render(<GoogleDrivePickerButton label="Add Google Drive folder" />)
    const button = screen.getByRole('button', {
      name: 'Add Google Drive folder',
    })
    expect(button.getAttribute('data-tour-id')).toBe(
      'explorer.add-google-drive-folder'
    )

    fireEvent.click(button)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open notebooks' })
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Select this folder' })
    )

    await waitFor(() =>
      expect(mocks.updateFolder).toHaveBeenCalledWith(
        'https://drive.google.com/drive/folders/shared-drive-id',
        'notebooks'
      )
    )
    expect(mocks.addItem).toHaveBeenCalledWith('local://folder/shared-drive')
    expect(tourUiController.getSnapshot().googleDriveFolderAddedCount).toBe(
      initialCount + 1
    )
  })

  it('preserves a resource key when mounting a protected folder', async () => {
    mocks.listRoots.mockResolvedValue([
      {
        id: 'protected-folder',
        name: 'Protected folder',
        resourceKey: 'folder-key',
      },
    ])
    mocks.updateFolder.mockResolvedValue('local://folder/protected')

    render(<GoogleDrivePickerButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose Folder' }))
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open Protected folder' })
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Select this folder' })
    )

    await waitFor(() =>
      expect(mocks.updateFolder).toHaveBeenCalledWith(
        'https://drive.google.com/drive/folders/protected-folder?resourcekey=folder-key',
        'Protected folder'
      )
    )
  })

  it('shows actionable authorization failures', async () => {
    mocks.ensureAccessToken.mockRejectedValue(new Error('invalid credential'))
    render(<GoogleDrivePickerButton />)

    fireEvent.click(screen.getByRole('button', { name: 'Choose Folder' }))

    expect((await screen.findByRole('alert')).textContent).toContain(
      'could not authorize Google Drive'
    )
  })

  it('shows actionable mount failures', async () => {
    mocks.updateFolder.mockRejectedValue(new Error('forbidden'))
    render(<GoogleDrivePickerButton />)

    fireEvent.click(screen.getByRole('button', { name: 'Choose Folder' }))
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open notebooks' })
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Select this folder' })
    )

    expect((await screen.findByRole('alert')).textContent).toContain(
      'effective Drive identity can read it'
    )
  })
})
