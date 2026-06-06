// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { ButtonHTMLAttributes, ElementType, HTMLAttributes } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotebookSyncStatusRow } from '../storage/local'

let isDriveSyncing = false
const ensureAccessTokenMock = vi.fn(async () => 'token')
const listFileSyncStatusesMock = vi.fn<() => Promise<NotebookSyncStatusRow[]>>()
const syncMock = vi.fn(async (_uri: string) => undefined)
const openNotebookMock = vi.fn(async (uri: string) => ({
  localUri: uri,
  entry: { name: 'Opened Notebook' },
}))
const setCurrentDocMock = vi.fn()
const showDocumentMock = vi.fn()
const storeMock = {
  listFileSyncStatuses: listFileSyncStatusesMock,
  sync: syncMock,
}

vi.mock('@radix-ui/themes', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  ScrollArea: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  Text: ({
    children,
    as: Component = 'span',
    size: _size,
    weight: _weight,
    ...props
  }: HTMLAttributes<HTMLElement> & {
    as?: ElementType
    size?: string
    weight?: string
  }) => <Component {...props}>{children}</Component>,
}))

vi.mock('../contexts/GoogleAuthContext', () => ({
  useGoogleAuth: () => ({
    ensureAccessToken: ensureAccessTokenMock,
    isDriveSyncing,
  }),
}))

vi.mock('../contexts/CurrentDocContext', () => ({
  useCurrentDoc: () => ({
    setCurrentDoc: setCurrentDocMock,
  }),
}))

vi.mock('../contexts/NotebookContext', () => ({
  useNotebookContext: () => ({
    openNotebook: openNotebookMock,
  }),
}))

vi.mock('../contexts/NotebookStoreContext', () => ({
  useNotebookStore: () => ({
    store: storeMock,
  }),
}))

vi.mock('../contexts/WorkspaceDocumentContext', () => ({
  useWorkspaceDocumentContext: () => ({
    showDocument: showDocumentMock,
  }),
}))

import { DriveSyncStatusTab } from './DriveSyncStatusTab'

const rows: NotebookSyncStatusRow[] = [
  {
    localUri: 'local://file/beta',
    title: 'Beta Notebook',
    googleDriveUrl: 'https://drive.google.com/file/d/beta/view',
    revision: 'bbb',
    upstreamRevision: 'rev-beta',
    lastSynced: '2026-05-31T10:00:00.000Z',
    syncStatus: 'pending',
  },
  {
    localUri: 'local://file/alpha',
    title: 'Alpha Notebook',
    googleDriveUrl: 'https://drive.google.com/file/d/alpha/view',
    revision: 'aaa',
    upstreamRevision: 'rev-alpha',
    lastSynced: '2026-05-30T10:00:00.000Z',
    syncStatus: 'synced',
  },
]

async function waitForStatusLoad(): Promise<void> {
  await screen.findByText('Alpha Notebook')
  await waitFor(() => {
    expect(
      (screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })
}

describe('DriveSyncStatusTab', () => {
  beforeEach(() => {
    isDriveSyncing = true
    ensureAccessTokenMock.mockClear()
    listFileSyncStatusesMock.mockReset()
    listFileSyncStatusesMock.mockResolvedValue(rows)
    syncMock.mockClear()
    openNotebookMock.mockClear()
    setCurrentDocMock.mockClear()
    showDocumentMock.mockClear()
  })

  it('filters string columns by prefix', async () => {
    render(<DriveSyncStatusTab />)

    await waitForStatusLoad()
    act(() => {
      fireEvent.change(screen.getByLabelText('Filter Title'), {
        target: { value: 'Bet' },
      })
    })

    expect(screen.getByText('Beta Notebook')).toBeTruthy()
    expect(screen.queryByText('Alpha Notebook')).toBeNull()
  })

  it('sorts date columns ascending and descending', async () => {
    render(<DriveSyncStatusTab />)

    await waitForStatusLoad()
    act(() => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Sort by Last Synced' })
      )
    })

    const body = screen.getByRole('table').querySelector('tbody')
    expect(body).toBeTruthy()
    let renderedRows = within(body as HTMLElement).getAllByRole('row')
    expect(within(renderedRows[0]).getByText('Alpha Notebook')).toBeTruthy()

    act(() => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Sort by Last Synced' })
      )
    })
    renderedRows = within(body as HTMLElement).getAllByRole('row')
    expect(within(renderedRows[0]).getByText('Beta Notebook')).toBeTruthy()
  })

  it('shows column descriptions from help icons', async () => {
    render(<DriveSyncStatusTab />)

    await waitForStatusLoad()
    const revisionHelp = screen.getByRole('button', {
      name: 'About Revision',
    })
    expect(screen.queryByRole('tooltip')).toBeNull()

    act(() => {
      fireEvent.mouseEnter(revisionHelp)
    })
    expect(screen.getByRole('tooltip').textContent).toContain(
      'Local content checksum'
    )

    act(() => {
      fireEvent.mouseLeave(revisionHelp)
    })
    expect(screen.queryByRole('tooltip')).toBeNull()

    act(() => {
      fireEvent.click(
        screen.getByRole('button', { name: 'About Upstream Revision' })
      )
    })
    expect(screen.getByRole('tooltip').textContent).toContain(
      'Google Drive headRevisionId'
    )
  })

  it('opens local URI links in the workspace', async () => {
    render(<DriveSyncStatusTab />)

    await waitForStatusLoad()
    act(() => {
      fireEvent.click(screen.getByRole('link', { name: 'local://file/beta' }))
    })

    await waitFor(() => {
      expect(openNotebookMock).toHaveBeenCalledWith('local://file/beta')
      expect(showDocumentMock).toHaveBeenCalledWith('local://file/beta', {
        title: 'Opened Notebook',
      })
      expect(setCurrentDocMock).toHaveBeenCalledWith('local://file/beta')
    })
  })

  it('syncs files that require it', async () => {
    render(<DriveSyncStatusTab />)

    await waitForStatusLoad()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Sync Required (1)' }))
    })

    await waitFor(() => {
      expect(ensureAccessTokenMock).toHaveBeenCalledWith({
        interactive: true,
      })
      expect(syncMock).toHaveBeenCalledWith('local://file/beta')
    })
    expect(syncMock).not.toHaveBeenCalledWith('local://file/alpha')
  })
})
