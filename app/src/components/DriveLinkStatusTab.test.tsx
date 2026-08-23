// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import DriveLinkStatusTab from './DriveLinkStatusTab'

const mocks = vi.hoisted(() => ({
  cancelIntent: vi.fn(),
  trustAndOpen: vi.fn(async () => undefined),
}))

vi.mock('../lib/driveLinkCoordinator', () => ({
  driveLinkCoordinator: {
    cancelIntent: mocks.cancelIntent,
    trustAndOpen: mocks.trustAndOpen,
  },
  useDriveLinkCoordinatorSnapshot: () => ({
    authBlocked: false,
    lastErrorMessage: null,
    intents: [
      {
        id: 'intent-1',
        remoteUri: 'https://drive.google.com/file/d/file-1/view',
        action: 'open_shared_file',
        source: 'url',
        status: 'awaiting_review',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        retryCount: 1,
        preflight: {
          fileId: 'file-1',
          uri: 'https://drive.google.com/file/d/file-1/view',
          name: 'external-design.ipynb',
          mimeType: 'application/x-ipynb+json',
          parents: [{ name: 'Partner Folder' }],
          owners: [
            {
              displayName: 'External Owner',
              emailAddress: 'owner@external.example',
            },
          ],
          canDownload: true,
        },
        trustDecision: {
          trusted: false,
          reason: 'Owner is external.',
        },
      },
    ],
  }),
}))

describe('DriveLinkStatusTab', () => {
  it('shows metadata and requires an explicit action for an untrusted file', () => {
    render(<DriveLinkStatusTab onLogin={vi.fn()} onRetry={vi.fn()} />)

    expect(screen.getByText('Review Shared Notebook')).toBeTruthy()
    expect(screen.getByText('external-design.ipynb')).toBeTruthy()
    expect(
      screen.getByText('External Owner (owner@external.example)')
    ).toBeTruthy()
    expect(screen.getByText('Partner Folder')).toBeTruthy()
    expect(
      screen.getByText(/Notebook content will not be downloaded or rendered/i)
    ).toBeTruthy()

    fireEvent.click(screen.getByTestId('drive-link-trust-open'))
    expect(mocks.trustAndOpen).toHaveBeenCalledWith('intent-1')

    fireEvent.click(screen.getByTestId('drive-link-cancel'))
    expect(mocks.cancelIntent).toHaveBeenCalledWith('intent-1')
  })
})
