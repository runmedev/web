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
import { SyncWorkQueue } from '../storage/syncWorkQueue'
import type { GoogleDriveCredentialStatus } from '../contexts/GoogleAuthContext'

let isDriveSyncing = false
let driveCredentialStatus: GoogleDriveCredentialStatus = {
  connected: true,
  authFlow: 'impersonated_service_account' as const,
  effectivePrincipal: 'runme-drive@example.iam.gserviceaccount.com',
  authorizingPrincipal: 'jeremy@lewi.us',
  expiresAt: '2026-08-21T23:00:00.000Z',
  renewal: 'interactive' as const,
  lastError: null as string | null,
}
const ensureAccessTokenMock = vi.fn(async () => 'token')
const listFileSyncStatusesMock = vi.fn<() => Promise<NotebookSyncStatusRow[]>>()
const syncMock = vi.fn(async (_uri: string) => undefined)
const openNotebookMock = vi.fn(async (uri: string) => ({
  localUri: uri,
  entry: { name: 'Opened Notebook' },
}))
const setCurrentDocMock = vi.fn()
const showDocumentMock = vi.fn()
const clearLinkedResourceCacheMock = vi.fn(async () => 1536)
const queueMetrics = new SyncWorkQueue().getMetrics()
const storeMock = {
  getDriveQueueMetrics: vi.fn(async () => queueMetrics),
  listFileSyncStatusPage: vi.fn(async (_options?: unknown) => ({
    rows: await listFileSyncStatusesMock(),
    nextCursor: undefined as any,
  })),
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
    driveCredentialStatus,
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

vi.mock('../lib/linkedResourceCache', () => ({
  getLinkedResourceCache: () => ({
    clear: clearLinkedResourceCacheMock,
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
  it('loads only the requested page and supports back navigation', async () => {
    const cursor = { table: 'files' as const, after: 'last-first-page' }
    storeMock.listFileSyncStatusPage.mockImplementationOnce(async () => ({
      rows: [rows[1]],
      nextCursor: cursor,
    }))
    storeMock.listFileSyncStatusPage.mockImplementationOnce(async () => ({
      rows: [rows[0]],
      nextCursor: undefined,
    }))
    render(<DriveSyncStatusTab />)
    await waitForStatusLoad()
    expect(screen.queryByText('Beta Notebook')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(await screen.findByText('Beta Notebook')).toBeTruthy()
    expect(screen.queryByText('Alpha Notebook')).toBeNull()
    expect(storeMock.listFileSyncStatusPage).toHaveBeenLastCalledWith({
      cursor,
      limit: 50,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }))
    await waitForStatusLoad()
    expect(storeMock.listFileSyncStatusPage).toHaveBeenLastCalledWith({
      cursor: undefined,
      limit: 50,
    })
  })

  it('coalesces update bursts during a slow status scan and refreshes once afterward', async () => {
    let finish!: (value: NotebookSyncStatusRow[]) => void
    listFileSyncStatusesMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    render(<DriveSyncStatusTab />)
    act(() => {
      for (let i = 0; i < 100; i++) {
        window.dispatchEvent(new CustomEvent('local-notebook-sync-updated'))
        window.dispatchEvent(new CustomEvent('local-notebook-updated'))
        window.dispatchEvent(new CustomEvent('local-notebook-sync-updated'))
      }
    })
    expect(listFileSyncStatusesMock).toHaveBeenCalledTimes(1)
    await act(async () => finish(rows))
    await waitForStatusLoad()
    await waitFor(() =>
      expect(listFileSyncStatusesMock).toHaveBeenCalledTimes(2)
    )
  })

  it('does not start a queued refresh after the status page closes', async () => {
    let finish!: (value: NotebookSyncStatusRow[]) => void
    listFileSyncStatusesMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const view = render(<DriveSyncStatusTab />)
    act(() => window.dispatchEvent(new CustomEvent('local-notebook-updated')))
    view.unmount()
    await act(async () => finish(rows))
    expect(listFileSyncStatusesMock).toHaveBeenCalledTimes(1)
  })

  it('excludes untouched Drive placeholders from bulk sync and allows filtering them', async () => {
    listFileSyncStatusesMock.mockResolvedValue([
      ...rows,
      {
        ...rows[0],
        localUri: 'local://file/unopened',
        title: 'Unopened',
        syncStatus: 'not-downloaded',
      },
    ])
    render(<DriveSyncStatusTab />)
    await waitForStatusLoad()
    fireEvent.click(
      screen.getByRole('button', { name: 'Sync Required on Page (1)' })
    )
    await waitFor(() =>
      expect(syncMock).toHaveBeenCalledWith('local://file/beta')
    )
    expect(syncMock).not.toHaveBeenCalledWith('local://file/unopened')
    fireEvent.click(
      screen.getByRole('button', { name: 'Filter Sync Status: All statuses' })
    )
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Filter Sync Status: not-downloaded',
      })
    )
    expect(screen.getByText('Unopened')).toBeTruthy()
    expect(screen.queryByText('Beta Notebook')).toBeNull()
  })

  it('includes owner queue monitoring above the file status table', async () => {
    render(<DriveSyncStatusTab />)
    await waitForStatusLoad()
    expect(
      await screen.findByRole('img', {
        name: 'Waiting queue depth, peak per ten seconds',
      })
    ).toBeTruthy()
    expect(
      screen.getByRole('img', {
        name: 'Eligible-to-dequeue wait histogram, 0 attempts',
      })
    ).toBeTruthy()
  })

  beforeEach(() => {
    window.localStorage.clear()
    isDriveSyncing = true
    driveCredentialStatus = {
      connected: true,
      authFlow: 'impersonated_service_account',
      effectivePrincipal: 'runme-drive@example.iam.gserviceaccount.com',
      authorizingPrincipal: 'jeremy@lewi.us',
      expiresAt: '2026-08-21T23:00:00.000Z',
      renewal: 'interactive',
      lastError: null,
    }
    ensureAccessTokenMock.mockClear()
    listFileSyncStatusesMock.mockReset()
    listFileSyncStatusesMock.mockResolvedValue(rows)
    syncMock.mockClear()
    openNotebookMock.mockClear()
    setCurrentDocMock.mockClear()
    showDocumentMock.mockClear()
    clearLinkedResourceCacheMock.mockClear()
  })

  it('distinguishes a failed attempt and retry eligibility from the last successful sync', async () => {
    listFileSyncStatusesMock.mockResolvedValue([
      {
        ...rows[1],
        syncStatus: 'error',
        lastError: 'Drive authorization is required.',
        lastSyncAttemptedAt: '2026-09-23T12:00:00Z',
        nextSyncAttemptAt: '2026-09-23T12:02:00Z',
      },
    ])
    render(<DriveSyncStatusTab />)
    await waitForStatusLoad()
    expect(screen.getByText('Drive authorization is required.')).toBeTruthy()
    expect(screen.getByText(/^Last attempt:/)).toBeTruthy()
    expect(screen.getByText(/^Retry eligible:.*when connected/)).toBeTruthy()
    expect(
      screen.getByText(new Date(rows[1].lastSynced!).toLocaleString())
    ).toBeTruthy()
  })

  it('retries pending creation with Drive auth without offering a broken notebook link', async () => {
    listFileSyncStatusesMock.mockResolvedValue([
      {
        ...rows[1],
        localUri: 'drive-create:pending',
        googleDriveUrl: '',
        syncStatus: 'pending-upstream-create',
      },
    ])
    render(<DriveSyncStatusTab />)
    await waitForStatusLoad()
    expect(
      screen.queryByRole('link', { name: 'drive-create:pending' })
    ).toBeNull()
    fireEvent.click(
      screen.getByRole('button', { name: 'Sync Required on Page (1)' })
    )
    await waitFor(() =>
      expect(syncMock).toHaveBeenCalledWith('drive-create:pending')
    )
    expect(ensureAccessTokenMock).toHaveBeenCalledWith({ interactive: true })
    expect(openNotebookMock).not.toHaveBeenCalled()
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

  it('explains the status refresh action on hover', async () => {
    render(<DriveSyncStatusTab />)

    await waitForStatusLoad()
    const description =
      'Reloads this page from local notebook sync metadata. It does not sync files.'

    expect(
      screen.getByRole('button', { name: 'Refresh' }).getAttribute('title')
    ).toBe(description)

    fireEvent.mouseEnter(screen.getByRole('button', { name: 'About Refresh' }))
    expect(screen.getByRole('tooltip').textContent).toBe(description)
  })

  it('shows the active Drive credential identity and expiration', async () => {
    window.localStorage.setItem(
      'runme/app-login-configuration',
      JSON.stringify({
        identitySharing: 'shared',
        mode: 'service_account',
        humanAccount: 'jeremy@lewi.us',
        serviceAccount: 'runme-drive@example.iam.gserviceaccount.com',
      })
    )
    render(<DriveSyncStatusTab />)

    await waitForStatusLoad()
    const status = screen.getByTestId('drive-credential-status')
    const configured = within(status).getByLabelText(
      'Configured Google Drive identity'
    )
    expect(
      within(configured).getByText('Impersonated Google service account')
    ).toBeTruthy()
    expect(
      within(configured).getByText(
        'runme-drive@example.iam.gserviceaccount.com'
      )
    ).toBeTruthy()
    expect(within(configured).getByText('jeremy@lewi.us')).toBeTruthy()
    const active = within(status).getByLabelText(
      'Active Google Drive credential'
    )
    expect(
      within(active).getByText('Impersonated service-account access token')
    ).toBeTruthy()
    expect(
      within(active).getByText('runme-drive@example.iam.gserviceaccount.com')
    ).toBeTruthy()
    expect(within(active).getByText('jeremy@lewi.us')).toBeTruthy()
    expect(status.querySelector('time')?.getAttribute('dateTime')).toBe(
      '2026-08-21T23:00:00.000Z'
    )
    expect(
      within(status).getByText('Interactive authorization required')
    ).toBeTruthy()
  })

  it('distinguishes configured impersonation from a disconnected credential', async () => {
    window.localStorage.setItem(
      'runme/app-login-configuration',
      JSON.stringify({
        identitySharing: 'shared',
        mode: 'service_account',
        humanAccount: 'jeremy@lewi.us',
        serviceAccount: 'runme-drive@example.iam.gserviceaccount.com',
      })
    )
    isDriveSyncing = false
    driveCredentialStatus = {
      connected: false,
      authFlow: null,
      effectivePrincipal: null,
      authorizingPrincipal: null,
      expiresAt: null,
      renewal: null,
      lastError: null,
    }

    render(<DriveSyncStatusTab />)

    await waitForStatusLoad()
    const status = screen.getByTestId('drive-credential-status')
    const configured = within(status).getByLabelText(
      'Configured Google Drive identity'
    )
    expect(
      within(configured).getByText('Impersonated Google service account')
    ).toBeTruthy()
    expect(
      within(configured).getByText(
        'runme-drive@example.iam.gserviceaccount.com'
      )
    ).toBeTruthy()
    expect(within(configured).getByText('jeremy@lewi.us')).toBeTruthy()

    const active = within(status).getByLabelText(
      'Active Google Drive credential'
    )
    expect(within(active).getByText('Disconnected')).toBeTruthy()
    expect(within(active).getByText('None')).toBeTruthy()
    expect(within(active).getAllByText('Not available')).toHaveLength(2)
  })

  it('links to Google Cloud settings from an actionable auth error', async () => {
    driveCredentialStatus = {
      connected: false,
      authFlow: null,
      effectivePrincipal: null,
      authorizingPrincipal: null,
      expiresAt: null,
      renewal: null,
      lastError:
        'IAM Service Account Credentials API is not enabled. Enable it, then retry: https://console.cloud.google.com/apis/library/iamcredentials.googleapis.com?project=554943104515',
    }

    render(<DriveSyncStatusTab />)

    await waitForStatusLoad()
    const link = screen.getByRole('link', {
      name: 'Open Google Cloud API settings',
    })
    expect(link.getAttribute('href')).toBe(
      'https://console.cloud.google.com/apis/library/iamcredentials.googleapis.com?project=554943104515'
    )
  })

  it('filters sync status by selected values', async () => {
    render(<DriveSyncStatusTab />)

    await waitForStatusLoad()
    act(() => {
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Filter Sync Status: All statuses',
        })
      )
    })
    act(() => {
      fireEvent.click(screen.getByLabelText('Filter Sync Status: pending'))
    })

    expect(screen.getByText('Beta Notebook')).toBeTruthy()
    expect(screen.queryByText('Alpha Notebook')).toBeNull()

    act(() => {
      fireEvent.click(screen.getByLabelText('Filter Sync Status: synced'))
    })
    expect(screen.getByText('Beta Notebook')).toBeTruthy()
    expect(screen.getByText('Alpha Notebook')).toBeTruthy()

    act(() => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Clear status filters' })
      )
    })
    expect(screen.getByText('Beta Notebook')).toBeTruthy()
    expect(screen.getByText('Alpha Notebook')).toBeTruthy()
  })

  it('closes the sync status filter when clicking outside', async () => {
    render(<DriveSyncStatusTab />)

    await waitForStatusLoad()
    act(() => {
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Filter Sync Status: All statuses',
        })
      )
    })
    expect(screen.getByRole('menu')).toBeTruthy()

    act(() => {
      fireEvent.pointerDown(document.body)
    })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('sorts date columns ascending and descending', async () => {
    render(<DriveSyncStatusTab />)

    await waitForStatusLoad()
    act(() => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Sort by Last Synced' })
      )
    })
    expect(
      screen.getByRole('button', { name: 'Sort by Last Synced' }).textContent
    ).toContain('↑')

    const body = screen.getByRole('table').querySelector('tbody')
    expect(body).toBeTruthy()
    let renderedRows = within(body as HTMLElement).getAllByRole('row')
    expect(within(renderedRows[0]).getByText('Alpha Notebook')).toBeTruthy()

    act(() => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Sort by Last Synced' })
      )
    })
    expect(
      screen.getByRole('button', { name: 'Sort by Last Synced' }).textContent
    ).toContain('↓')
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
      fireEvent.click(
        screen.getByRole('button', { name: 'Sync Required on Page (1)' })
      )
    })

    await waitFor(() => {
      expect(ensureAccessTokenMock).toHaveBeenCalledWith({
        interactive: true,
      })
      expect(syncMock).toHaveBeenCalledWith('local://file/beta')
    })
    expect(syncMock).not.toHaveBeenCalledWith('local://file/alpha')
  })

  it('syncs non-Drive files without waiting for Google auth', async () => {
    listFileSyncStatusesMock.mockResolvedValue([
      {
        localUri: 'local://file/local-pending',
        title: 'Local Pending Notebook',
        googleDriveUrl: '',
        revision: 'local',
        upstreamRevision: 'local-upstream',
        lastSynced: '2026-05-31T10:00:00.000Z',
        syncStatus: 'pending',
      },
      {
        localUri: 'local://file/drive-pending',
        title: 'Drive Pending Notebook',
        googleDriveUrl: 'https://drive.google.com/file/d/drive/view',
        revision: 'drive',
        upstreamRevision: 'drive-upstream',
        lastSynced: '2026-05-31T10:00:00.000Z',
        syncStatus: 'pending',
      },
    ])
    ensureAccessTokenMock.mockRejectedValueOnce(new Error('auth unavailable'))

    render(<DriveSyncStatusTab />)

    await screen.findByText('Local Pending Notebook')
    await waitFor(() => {
      expect(
        (screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement)
          .disabled
      ).toBe(false)
    })
    act(() => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Sync Required on Page (2)' })
      )
    })

    await waitFor(() => {
      expect(syncMock).toHaveBeenCalledWith('local://file/local-pending')
      expect(ensureAccessTokenMock).toHaveBeenCalledWith({
        interactive: true,
      })
    })
    expect(syncMock).not.toHaveBeenCalledWith('local://file/drive-pending')
  })

  it('clears downloaded linked-resource media without touching Drive', async () => {
    render(<DriveSyncStatusTab />)

    await waitForStatusLoad()
    fireEvent.click(
      screen.getByRole('button', { name: 'Clear downloaded media' })
    )

    await waitFor(() => {
      expect(clearLinkedResourceCacheMock).toHaveBeenCalledOnce()
      expect(
        screen.getByTestId('linked-resource-cache-message').textContent
      ).toBe('Cleared 1.5 KiB of downloaded media.')
    })
  })
})
