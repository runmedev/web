// @vitest-environment jsdom
import { useEffect } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type PanelKey = 'explorer' | 'open-documents' | 'chatkit' | null

let authData: {} | null = null
let isDriveSyncing = false
let activePanelState: PanelKey = 'explorer'
let currentDocUri: string | null = null
let openDocumentsState: {
  uri: string
  title: string
  state?: string
  readOnly?: boolean
}[] = []
let chatKitMountCount = 0
let chatKitUnmountCount = 0
const ensureAccessTokenMock = vi.fn(async () => 'token')
const loginWithRedirectMock = vi.fn()
const logoutMock = vi.fn()
const togglePanelMock = vi.fn()
const setCurrentDocMock = vi.fn()
const closeWorkspaceDocumentMock = vi.fn()

vi.mock('../../browserAdapter.client', () => ({
  useBrowserAuthData: () => authData,
  getBrowserAdapter: () => ({
    loginWithRedirect: loginWithRedirectMock,
    logout: logoutMock,
  }),
}))

vi.mock('../../contexts/SidePanelContext', () => ({
  useSidePanel: () => ({
    activePanel: activePanelState,
    togglePanel: togglePanelMock,
  }),
}))

vi.mock('../../contexts/WorkspaceDocumentContext', () => ({
  useWorkspaceDocumentContext: () => ({
    useWorkspaceDocuments: () => openDocumentsState,
    closeWorkspaceDocument: closeWorkspaceDocumentMock,
  }),
}))

vi.mock('../../contexts/CurrentDocContext', () => ({
  useCurrentDoc: () => ({
    getCurrentDoc: () => currentDocUri,
    setCurrentDoc: setCurrentDocMock,
  }),
}))

vi.mock('../../contexts/GoogleAuthContext', () => ({
  useGoogleAuth: () => ({
    ensureAccessToken: ensureAccessTokenMock,
    isDriveSyncing,
  }),
}))

vi.mock('../ChatKit/ChatKitPanel', () => ({
  default: () => {
    useEffect(() => {
      chatKitMountCount += 1
      return () => {
        chatKitUnmountCount += 1
      }
    }, [])
    return <div data-testid="chatkit-panel-mock" />
  },
}))

vi.mock('../Workspace/WorkspaceExplorer', () => ({
  default: () => <div data-testid="workspace-explorer-mock" />,
}))

import { SidePanelContent, SidePanelToolbar } from './SidePanel'

describe('SidePanelToolbar drive status button', () => {
  beforeEach(() => {
    authData = null
    isDriveSyncing = false
    activePanelState = 'explorer'
    currentDocUri = null
    openDocumentsState = []
    chatKitMountCount = 0
    chatKitUnmountCount = 0
    ensureAccessTokenMock.mockClear()
    loginWithRedirectMock.mockClear()
    logoutMock.mockClear()
    togglePanelMock.mockClear()
    setCurrentDocMock.mockClear()
    closeWorkspaceDocumentMock.mockClear()
  })

  it('renders the Drive status button above Login and starts auth when not syncing', async () => {
    render(<SidePanelToolbar />)

    const driveStatusButton = screen.getByRole('button', {
      name: 'Google Drive status: Not syncing',
    })
    const loginButton = screen.getByRole('button', { name: 'Login' })

    expect(
      driveStatusButton.compareDocumentPosition(loginButton) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    await act(async () => {
      fireEvent.click(driveStatusButton)
      await Promise.resolve()
    })
    expect(ensureAccessTokenMock).toHaveBeenCalledWith({ interactive: true })
  })

  it('does not start auth when Drive is already syncing', () => {
    isDriveSyncing = true
    render(<SidePanelToolbar />)

    const driveStatusButton = screen.getByRole('button', {
      name: 'Google Drive status: Syncing',
    })
    fireEvent.click(driveStatusButton)

    expect(ensureAccessTokenMock).not.toHaveBeenCalled()
  })

  it('exposes an Open Documents button in the toolbar', () => {
    render(<SidePanelToolbar />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Toggle Open Documents panel' })
    )

    expect(togglePanelMock).toHaveBeenCalledWith('open-documents')
  })
})

describe('SidePanelContent ChatKit persistence', () => {
  beforeEach(() => {
    activePanelState = 'explorer'
    currentDocUri = null
    openDocumentsState = []
    chatKitMountCount = 0
    chatKitUnmountCount = 0
    setCurrentDocMock.mockClear()
    closeWorkspaceDocumentMock.mockClear()
  })

  it('keeps ChatKit mounted when switching from ChatKit to Explorer and back', () => {
    activePanelState = 'chatkit'
    const { rerender } = render(<SidePanelContent />)

    expect(screen.getByTestId('chatkit-panel-mock')).toBeTruthy()
    expect(chatKitMountCount).toBe(1)
    expect(chatKitUnmountCount).toBe(0)

    activePanelState = 'explorer'
    rerender(<SidePanelContent />)

    expect(screen.getByTestId('chatkit-panel-mock')).toBeTruthy()
    expect(screen.getByTestId('workspace-explorer-mock')).toBeTruthy()
    expect(chatKitUnmountCount).toBe(0)

    activePanelState = 'chatkit'
    rerender(<SidePanelContent />)

    expect(screen.getByTestId('chatkit-panel-mock')).toBeTruthy()
    expect(chatKitMountCount).toBe(1)
    expect(chatKitUnmountCount).toBe(0)
  })

  it('keeps the explorer subtree mounted when the side panel is collapsed', () => {
    activePanelState = 'explorer'
    const { rerender } = render(<SidePanelContent />)

    expect(screen.getByTestId('workspace-explorer-mock')).toBeTruthy()

    activePanelState = null
    rerender(<SidePanelContent />)

    expect(screen.getByTestId('workspace-explorer-mock')).toBeTruthy()
  })

  it('renders the Open Documents panel and routes document actions through shared context state', () => {
    activePanelState = 'open-documents'
    currentDocUri = 'local://file/alpha.json'
    openDocumentsState = [
      { uri: 'local://file/alpha.json', title: 'alpha.json' },
      { uri: 'diff://notebook/beta', title: 'beta diff' },
    ]
    closeWorkspaceDocumentMock.mockReturnValue('diff://notebook/beta')

    render(<SidePanelContent />)

    expect(screen.getByText('Open Documents')).toBeTruthy()

    fireEvent.click(screen.getByText('beta diff'))
    expect(setCurrentDocMock).toHaveBeenCalledWith('diff://notebook/beta')

    fireEvent.click(screen.getByRole('button', { name: 'Close alpha.json' }))
    expect(closeWorkspaceDocumentMock).toHaveBeenCalledWith(
      'local://file/alpha.json'
    )
  })

  it('shows blocked notebook status from open entry metadata', () => {
    activePanelState = 'open-documents'
    currentDocUri = 'local://file/blocked'
    openDocumentsState = [
      {
        uri: 'local://file/blocked',
        title: 'blocked.json',
        state: 'blocked',
      },
    ]

    render(<SidePanelContent />)

    expect(screen.getByText('blocked.json')).toBeTruthy()
    expect(screen.getByTestId('open-notebook-status-blocked').textContent).toBe(
      'Blocked'
    )
  })

  it('shows read-only notebook status from open entry metadata', () => {
    currentDocUri = 'local://file/readonly'
    openDocumentsState = [
      {
        uri: 'local://file/readonly',
        title: 'readonly.json',
        state: 'loaded',
        readOnly: true,
      },
    ]

    render(<SidePanelContent />)

    expect(screen.getByText('readonly.json')).toBeTruthy()
    expect(
      screen.getByTestId('open-notebook-status-readonly').textContent
    ).toBe('Read-only')
  })
})
