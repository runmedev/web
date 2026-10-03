// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GoogleDriveResourcePickerDialog } from './GoogleDriveResourcePickerDialog'
import { IncompleteGoogleDriveSearchError } from './googleDriveBrowser'

const mocks = vi.hoisted(() => ({
  listChildren: vi.fn(),
  listRoots: vi.fn(),
  searchResources: vi.fn(),
  resolvePaths: vi.fn(),
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

vi.mock('./googleDrivePaths', () => ({
  resolveGoogleDriveResourcePaths: mocks.resolvePaths,
}))

describe('GoogleDriveResourcePickerDialog', () => {
  beforeEach(() => {
    mocks.resolvePaths.mockReset()
    mocks.resolvePaths.mockResolvedValue(undefined)
    mocks.listRoots.mockReset()
    mocks.listRoots.mockResolvedValue([
      { id: 'my-drive-root-id', name: 'My Drive' },
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
      .mockResolvedValueOnce([{ id: 'my-drive-root-id', name: 'My Drive' }])
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
    expect(mocks.listChildren).toHaveBeenNthCalledWith(
      2,
      'token',
      {
        id: 'drive-1',
        name: 'notebooks',
        driveId: 'drive-1',
      },
      'folder'
    )
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
    expect(mocks.listChildren).toHaveBeenCalledWith(
      'token',
      {
        id: 'folder-1',
        name: 'Design docs',
        mimeType: 'application/vnd.google-apps.folder',
        driveId: 'drive-1',
      },
      'folder'
    )
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

  it('contains keyboard focus and restores it when the dialog unmounts', async () => {
    const trigger = document.createElement('button')
    trigger.textContent = 'Open picker'
    document.body.appendChild(trigger)
    trigger.focus()

    const { unmount } = render(
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
    const cancel = screen.getByRole('button', { name: 'Cancel' })

    cancel.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(searchInput)

    searchInput.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(cancel)

    unmount()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })
})

/** Starts a search only after root discovery has completed. */
async function searchNotebooks() {
  await screen.findByRole('button', { name: 'Open My Drive' })
  fireEvent.change(screen.getByRole('searchbox'), {
    target: { value: 'Notebooks' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Search' }))
}

it('shows duplicate names immediately and progressively adds accessible full paths', async () => {
  mocks.listRoots.mockResolvedValue([{ id: 'my-root', name: 'My Drive' }])
  mocks.searchResources.mockResolvedValue([
    {
      id: 'a',
      name: 'Notebooks',
      mimeType: 'application/vnd.google-apps.folder',
    },
    {
      id: 'b',
      name: 'Notebooks',
      mimeType: 'application/vnd.google-apps.folder',
    },
  ])
  let publish!: (id: string, path: { label: string; complete: boolean }) => void
  let finish!: () => void
  mocks.resolvePaths.mockImplementation((_token, _matches, _roots, onPath) => {
    publish = onPath
    return new Promise<void>((resolve) => {
      finish = resolve
    })
  })
  render(
    <GoogleDriveResourcePickerDialog
      accessToken="token"
      mode="folder"
      onCancel={vi.fn()}
      onSelect={vi.fn()}
    />
  )
  await searchNotebooks()
  expect(
    await screen.findAllByRole('button', { name: 'Open folder Notebooks' })
  ).toHaveLength(2)
  expect(screen.getAllByText('Loading path…')).toHaveLength(2)
  await act(async () => {
    publish('a', { label: 'My Drive / Work / Notebooks', complete: true })
    publish('b', { label: 'Engineering / Team / Notebooks', complete: true })
    finish()
  })
  const rows = screen.getAllByRole('button', { name: 'Open folder Notebooks' })
  expect(
    document.getElementById(rows[0].getAttribute('aria-describedby')!)
      ?.textContent
  ).toBe('My Drive / Work / Notebooks')
  expect(screen.getByTitle('Engineering / Team / Notebooks')).toBeTruthy()
})

it.each(['navigation', 'new search', 'credentials', 'unmount'])(
  'aborts paths and ignores late callbacks after %s',
  async (action) => {
    mocks.listRoots.mockResolvedValue([{ id: 'my-root', name: 'My Drive' }])
    mocks.listChildren.mockResolvedValue([])
    mocks.searchResources.mockResolvedValue([
      {
        id: 'a',
        name: 'Notebooks',
        mimeType: 'application/vnd.google-apps.folder',
      },
    ])
    const pending: Array<{
      publish: (id: string, path: { label: string; complete: boolean }) => void
      signal: AbortSignal
      finish: () => void
    }> = []
    mocks.resolvePaths.mockImplementation(
      (_token, _matches, _roots, publish, signal) =>
        new Promise<void>((finish) => pending.push({ publish, signal, finish }))
    )
    const props = {
      accessToken: 'token',
      mode: 'folder' as const,
      onCancel: vi.fn(),
      onSelect: vi.fn(),
    }
    const view = render(<GoogleDriveResourcePickerDialog {...props} />)
    await searchNotebooks()
    await screen.findByRole('button', { name: 'Open folder Notebooks' })
    const first = pending[0]
    if (action === 'navigation')
      fireEvent.click(
        screen.getByRole('button', { name: 'Open folder Notebooks' })
      )
    if (action === 'new search') {
      fireEvent.change(screen.getByRole('searchbox'), {
        target: { value: 'Other' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Search' }))
      await waitFor(() => expect(pending).toHaveLength(2))
    }
    if (action === 'credentials')
      view.rerender(
        <GoogleDriveResourcePickerDialog {...props} accessToken="other-token" />
      )
    if (action === 'unmount') view.unmount()
    expect(first.signal.aborted).toBe(true)
    await act(async () => {
      first.publish('a', { label: 'Stale path', complete: true })
      first.finish()
      pending[1]?.finish()
    })
    expect(screen.queryByText('Stale path')).toBeNull()
  }
)

it('keeps file selection usable while a partial path is published', async () => {
  mocks.listRoots.mockResolvedValue([{ id: 'my-root', name: 'My Drive' }])
  mocks.searchResources.mockResolvedValue([
    {
      id: 'file-id',
      name: 'notes.json',
      mimeType: 'application/json',
      resourceKey: 'key',
    },
  ])
  mocks.resolvePaths.mockImplementation(
    async (_token, _matches, _roots, publish) => {
      publish('file-id', {
        label: '… / notes.json (partial path)',
        complete: false,
      })
    }
  )
  const onSelect = vi.fn()
  render(
    <GoogleDriveResourcePickerDialog
      accessToken="token"
      mode="file"
      onCancel={vi.fn()}
      onSelect={onSelect}
    />
  )
  await searchNotebooks()
  fireEvent.click(
    await screen.findByRole('button', { name: 'Select file notes.json' })
  )
  expect(screen.getByText('… / notes.json (partial path)')).toBeTruthy()
  fireEvent.click(
    screen.getByRole('button', { name: 'Select file', exact: true })
  )
  expect(onSelect).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'file-id', resourceKey: 'key' })
  )
})
