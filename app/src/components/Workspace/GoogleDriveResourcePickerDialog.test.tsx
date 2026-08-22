// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GoogleDriveResourcePickerDialog } from './GoogleDriveResourcePickerDialog'
import { IncompleteGoogleDriveSearchError } from './googleDriveBrowser'

const mocks = vi.hoisted(() => ({
  listChildren: vi.fn(),
  listRoots: vi.fn(),
  searchResources: vi.fn(),
}))

vi.mock('./googleDriveBrowser', async () => {
  const actual = await vi.importActual<typeof import('./googleDriveBrowser')>(
    './googleDriveBrowser'
  )
  return {
    ...actual,
    listGoogleDriveChildren: mocks.listChildren,
    listGoogleDriveRoots: mocks.listRoots,
    searchGoogleDriveResources: mocks.searchResources,
  }
})

describe('GoogleDriveResourcePickerDialog', () => {
  beforeEach(() => {
    mocks.listRoots.mockReset()
    mocks.listRoots.mockResolvedValue([
      { id: 'root', name: 'My Drive' },
      { id: 'drive-1', name: 'notebooks', driveId: 'drive-1' },
    ])
    mocks.listChildren.mockReset()
    mocks.listChildren.mockResolvedValue([])
    mocks.searchResources.mockReset()
    mocks.searchResources.mockResolvedValue([])
  })

  it('selects a Shared Drive root in folder mode', async () => {
    const onSelect = vi.fn()
    render(
      <GoogleDriveResourcePickerDialog
        accessToken="token"
        mode="folder"
        onCancel={vi.fn()}
        onSelect={onSelect}
      />
    )

    fireEvent.click(
      await screen.findByRole('button', { name: 'Open notebooks' })
    )
    expect(
      (
        await screen.findByRole('button', { name: 'Select this folder' })
      ).hasAttribute('disabled')
    ).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Select this folder' }))

    expect(onSelect).toHaveBeenCalledWith({
      id: 'drive-1',
      name: 'notebooks',
      mimeType: 'application/vnd.google-apps.folder',
    })
  })

  it('navigates folders and selects a file', async () => {
    mocks.listChildren
      .mockResolvedValueOnce([
        {
          id: 'folder-1',
          name: 'Designs',
          mimeType: 'application/vnd.google-apps.folder',
          driveId: 'drive-1',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'file-1',
          name: 'picker-demo.webm',
          mimeType: 'video/webm',
          driveId: 'drive-1',
        },
      ])
    const onSelect = vi.fn()
    render(
      <GoogleDriveResourcePickerDialog
        accessToken="token"
        mode="file"
        onCancel={vi.fn()}
        onSelect={onSelect}
      />
    )

    fireEvent.click(
      await screen.findByRole('button', { name: 'Open notebooks' })
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open folder Designs' })
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Select file picker-demo.webm',
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Select file' }))

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'file-1', name: 'picker-demo.webm' })
    )
    expect(
      screen
        .getByRole('button', { name: 'Designs' })
        .getAttribute('aria-current')
    ).toBe('page')
  })

  it('keeps an actionable error open and retries root listing', async () => {
    mocks.listRoots
      .mockRejectedValueOnce(new Error('Drive API disabled'))
      .mockResolvedValueOnce([{ id: 'root', name: 'My Drive' }])
    render(
      <GoogleDriveResourcePickerDialog
        accessToken="token"
        mode="folder"
        onCancel={vi.fn()}
        onSelect={vi.fn()}
      />
    )

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Verify that the Google Drive API is enabled'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Open My Drive' })).toBeTruthy()
    )
    expect(mocks.listRoots).toHaveBeenCalledTimes(2)
  })

  it('retries the folder that failed to load', async () => {
    mocks.listChildren
      .mockRejectedValueOnce(new Error('forbidden'))
      .mockResolvedValueOnce([])
    render(
      <GoogleDriveResourcePickerDialog
        accessToken="token"
        mode="folder"
        onCancel={vi.fn()}
        onSelect={vi.fn()}
      />
    )

    fireEvent.click(
      await screen.findByRole('button', { name: 'Open notebooks' })
    )
    expect((await screen.findByRole('alert')).textContent).toContain(
      'could not list items in notebooks'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await screen.findByText('This folder is empty.')
    expect(mocks.listChildren).toHaveBeenNthCalledWith(2, 'token', {
      id: 'drive-1',
      name: 'notebooks',
      driveId: 'drive-1',
    })
  })

  it('searches across Drive and navigates into a matching folder', async () => {
    mocks.searchResources.mockResolvedValue([
      {
        id: 'folder-1',
        name: 'Design docs',
        mimeType: 'application/vnd.google-apps.folder',
        driveId: 'drive-1',
      },
    ])
    render(
      <GoogleDriveResourcePickerDialog
        accessToken="token"
        mode="folder"
        onCancel={vi.fn()}
        onSelect={vi.fn()}
      />
    )

    const searchInput = await screen.findByRole('searchbox', {
      name: 'Search Google Drive',
    })
    fireEvent.change(searchInput, { target: { value: 'design' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    fireEvent.click(
      await screen.findByRole('button', { name: 'Open folder Design docs' })
    )
    await screen.findByText('This folder is empty.')
    expect(mocks.searchResources).toHaveBeenCalledWith(
      'token',
      'design',
      'folder'
    )
    expect(mocks.listChildren).toHaveBeenCalledWith('token', {
      id: 'folder-1',
      name: 'Design docs',
      mimeType: 'application/vnd.google-apps.folder',
      driveId: 'drive-1',
    })
    expect(screen.getByRole('button', { name: 'Design docs' })).toBeTruthy()
  })

  it('shows actionable guidance for an incomplete all-Drive search', async () => {
    mocks.searchResources.mockRejectedValue(
      new IncompleteGoogleDriveSearchError()
    )
    render(
      <GoogleDriveResourcePickerDialog
        accessToken="token"
        mode="folder"
        onCancel={vi.fn()}
        onSelect={vi.fn()}
      />
    )

    const searchInput = await screen.findByRole('searchbox', {
      name: 'Search Google Drive',
    })
    fireEvent.change(searchInput, { target: { value: 'design' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Narrow the search text and retry'
    )
  })
})
