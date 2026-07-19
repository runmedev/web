// @vitest-environment jsdom
import { useEffect } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type PanelKey = 'explorer' | 'open-documents' | 'outline' | 'chatkit' | null

let authData: {} | null = null
let isDriveSyncing = false
let activePanelState: PanelKey = 'explorer'
let commentsPanelOpen = false
let currentDocUri: string | null = null
let openDocumentsState: {
  uri: string
  title: string
  state?: string
  readOnly?: boolean
}[] = []
let runnersState: { name: string; endpoint: string; reconnect: boolean }[] = []
let chatKitMountCount = 0
let chatKitUnmountCount = 0
let notebookSnapshotState: {
  loaded: boolean
  notebook: {
    cells: {
      kind: number
      languageId: string
      refId: string
      value: string
    }[]
  }
} | null = null
const ensureAccessTokenMock = vi.fn(async () => 'token')
const startGoogleDriveOAuthMock = vi.fn(async () => ({
  status: 'started',
  authFlow: 'popup',
  mode: 'popup',
}))
const loginWithRedirectMock = vi.fn()
const logoutMock = vi.fn()
const togglePanelMock = vi.fn()
const toggleCommentsPanelMock = vi.fn()
const setCurrentDocMock = vi.fn()
const showDocumentMock = vi.fn()
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

vi.mock('../../contexts/CommentsPanelContext', () => ({
  useCommentsPanel: () => ({
    commentsPanelOpen,
    toggleCommentsPanel: toggleCommentsPanelMock,
  }),
}))

vi.mock('../../contexts/WorkspaceDocumentContext', () => ({
  useWorkspaceDocumentContext: () => ({
    useWorkspaceDocuments: () => openDocumentsState,
    showDocument: showDocumentMock,
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
    startGoogleDriveOAuth: startGoogleDriveOAuthMock,
    isDriveSyncing,
  }),
}))

vi.mock('../../contexts/NotebookContext', () => ({
  useNotebookContext: () => ({
    useNotebookSnapshot: () => notebookSnapshotState,
  }),
}))

vi.mock('../../contexts/RunnersContext', () => ({
  useRunners: () => ({
    defaultRunnerName: runnersState[0]?.name ?? null,
    listRunners: () => runnersState,
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
    commentsPanelOpen = false
    currentDocUri = null
    openDocumentsState = []
    runnersState = []
    chatKitMountCount = 0
    chatKitUnmountCount = 0
    notebookSnapshotState = null
    ensureAccessTokenMock.mockClear()
    startGoogleDriveOAuthMock.mockClear()
    loginWithRedirectMock.mockClear()
    logoutMock.mockClear()
    togglePanelMock.mockClear()
    toggleCommentsPanelMock.mockClear()
    setCurrentDocMock.mockClear()
    showDocumentMock.mockClear()
    closeWorkspaceDocumentMock.mockClear()
  })

  it('renders the Drive status button above Login and refreshes credentials', async () => {
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
    expect(startGoogleDriveOAuthMock).toHaveBeenCalledWith()
    expect(ensureAccessTokenMock).not.toHaveBeenCalled()
    expect(showDocumentMock).not.toHaveBeenCalled()
    expect(setCurrentDocMock).not.toHaveBeenCalled()
  })

  it('opens sync status from the Drive status context menu', () => {
    isDriveSyncing = true
    render(<SidePanelToolbar />)

    const driveStatusButton = screen.getByRole('button', {
      name: 'Google Drive status: Syncing',
    })
    expect(driveStatusButton.getAttribute('aria-haspopup')).toBe('menu')
    expect(driveStatusButton.getAttribute('aria-expanded')).toBe('false')

    fireEvent.contextMenu(driveStatusButton, { clientX: 20, clientY: 40 })

    expect(screen.getByRole('menu')).toBeTruthy()
    expect(driveStatusButton.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Status' }))
    expect(showDocumentMock).toHaveBeenCalledWith('status://drive-sync', {
      title: 'Google Drive Sync Status',
    })
    expect(setCurrentDocMock).toHaveBeenCalledWith('status://drive-sync')
    expect(ensureAccessTokenMock).not.toHaveBeenCalled()
    expect(startGoogleDriveOAuthMock).not.toHaveBeenCalled()
  })

  it('opens sync status from the Drive status keyboard menu', () => {
    render(<SidePanelToolbar />)

    const driveStatusButton = screen.getByRole('button', {
      name: 'Google Drive status: Not syncing',
    })
    fireEvent.keyDown(driveStatusButton, { key: 'F10', shiftKey: true })

    const statusMenuItem = screen.getByRole('menuitem', { name: 'Status' })
    expect(statusMenuItem).toBe(document.activeElement)

    fireEvent.click(statusMenuItem)
    expect(showDocumentMock).toHaveBeenCalledWith('status://drive-sync', {
      title: 'Google Drive Sync Status',
    })
    expect(setCurrentDocMock).toHaveBeenCalledWith('status://drive-sync')
    expect(ensureAccessTokenMock).not.toHaveBeenCalled()
    expect(startGoogleDriveOAuthMock).not.toHaveBeenCalled()
  })

  it('dismisses the Drive status context menu when clicking away', () => {
    render(<SidePanelToolbar />)

    fireEvent.contextMenu(
      screen.getByRole('button', { name: 'Google Drive status: Not syncing' }),
      { clientX: 20, clientY: 40 }
    )

    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('exposes an Open Documents button in the toolbar', () => {
    render(<SidePanelToolbar />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Toggle Open Documents panel' })
    )

    expect(togglePanelMock).toHaveBeenCalledWith('open-documents')
  })

  it('exposes an Outline button in the toolbar', () => {
    render(<SidePanelToolbar />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Toggle Outline panel' })
    )

    expect(togglePanelMock).toHaveBeenCalledWith('outline')
  })

  it('exposes an App Console button in the toolbar', () => {
    render(<SidePanelToolbar />)

    fireEvent.click(screen.getByRole('button', { name: 'Open App Console' }))

    expect(showDocumentMock).toHaveBeenCalledWith('app://console', {
      title: 'App Console',
    })
    expect(setCurrentDocMock).toHaveBeenCalledWith('app://console')
  })

  it('exposes a Comments button above App Console in the toolbar', () => {
    render(<SidePanelToolbar />)

    const commentsButton = screen.getByRole('button', {
      name: 'Toggle Comments panel',
    })
    const appConsoleButton = screen.getByRole('button', {
      name: 'Open App Console',
    })

    expect(
      commentsButton.compareDocumentPosition(appConsoleButton) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    fireEvent.click(commentsButton)
    expect(toggleCommentsPanelMock).toHaveBeenCalled()
  })

  it('opens the Version Information document from the toolbar', () => {
    render(<SidePanelToolbar />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Open Version Information' })
    )

    expect(showDocumentMock).toHaveBeenCalledWith('app://version', {
      title: 'Version Information',
    })
    expect(setCurrentDocMock).toHaveBeenCalledWith('app://version')
  })

  it('opens the runner status document from the toolbar', () => {
    runnersState = [
      {
        name: 'default',
        endpoint: 'ws://localhost:8080/ws',
        reconnect: true,
      },
    ]
    render(<SidePanelToolbar />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Runner status: Available' })
    )

    expect(showDocumentMock).toHaveBeenCalledWith('status://runners', {
      title: 'Notebook Runner Status',
    })
    expect(setCurrentDocMock).toHaveBeenCalledWith('status://runners')
  })

  it('opens the App Console and Logs documents from the toolbar', () => {
    render(<SidePanelToolbar />)

    fireEvent.click(screen.getByRole('button', { name: 'Open App Console' }))
    expect(showDocumentMock).toHaveBeenCalledWith('app://console', {
      title: 'App Console',
    })
    expect(setCurrentDocMock).toHaveBeenCalledWith('app://console')

    fireEvent.click(screen.getByRole('button', { name: 'Open Logs' }))
    expect(showDocumentMock).toHaveBeenCalledWith('app://logs', {
      title: 'Logs',
    })
    expect(setCurrentDocMock).toHaveBeenCalledWith('app://logs')
  })

  it('marks the runner status button unavailable when no runner endpoint exists', () => {
    runnersState = [{ name: 'default', endpoint: '', reconnect: true }]
    render(<SidePanelToolbar />)

    expect(
      screen.getByRole('button', { name: 'Runner status: Unavailable' })
    ).toBeTruthy()
  })
})

describe('SidePanelContent ChatKit persistence', () => {
  beforeEach(() => {
    activePanelState = 'explorer'
    currentDocUri = null
    openDocumentsState = []
    runnersState = []
    chatKitMountCount = 0
    chatKitUnmountCount = 0
    notebookSnapshotState = null
    setCurrentDocMock.mockClear()
    showDocumentMock.mockClear()
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
      { uri: 'app://version', title: 'Version Information' },
      { uri: 'status://runners', title: 'Notebook Runner Status' },
      { uri: 'status://drive-sync', title: 'Google Drive Sync Status' },
      { uri: 'app://console', title: 'App Console' },
      { uri: 'app://logs', title: 'Logs' },
    ]
    closeWorkspaceDocumentMock.mockReturnValue('diff://notebook/beta')

    render(<SidePanelContent />)

    expect(screen.getByText('Open Documents')).toBeTruthy()

    fireEvent.click(screen.getByText('beta diff'))
    expect(setCurrentDocMock).toHaveBeenCalledWith('diff://notebook/beta')
    expect(screen.getByText('Version · app://version')).toBeTruthy()
    expect(screen.getByText('Runner Status · status://runners')).toBeTruthy()
    expect(screen.getByText('Drive Sync · status://drive-sync')).toBeTruthy()
    expect(screen.getByText('App Console · app://console')).toBeTruthy()
    expect(screen.getByText('Logs · app://logs')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Close alpha.json' }))
    expect(closeWorkspaceDocumentMock).toHaveBeenCalledWith(
      'local://file/alpha.json'
    )
  })

  it('renders Markdown headings and scrolls the selected cell into view', () => {
    activePanelState = 'outline'
    currentDocUri = 'local://file/outline.json'
    notebookSnapshotState = {
      loaded: true,
      notebook: {
        cells: [
          {
            kind: 1,
            languageId: 'markdown',
            refId: 'cell-one',
            value: '# Title\n\n### Details',
          },
          {
            kind: 2,
            languageId: 'markdown',
            refId: 'cell-two',
            value: '## Second cell',
          },
        ],
      },
    }
    const cellElement = document.createElement('div')
    cellElement.dataset.cellRefId = 'cell-one'
    cellElement.scrollIntoView = vi.fn()
    const notebookElement = document.createElement('div')
    notebookElement.dataset.documentId = currentDocUri
    notebookElement.appendChild(cellElement)
    const secondCellElement = document.createElement('div')
    secondCellElement.dataset.cellRefId = 'cell-two'
    secondCellElement.scrollIntoView = vi.fn()
    notebookElement.appendChild(secondCellElement)
    document.body.appendChild(notebookElement)

    render(<SidePanelContent />)

    expect(screen.getByText('3 headings')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Details' }).dataset.headingLevel
    ).toBe('3')
    fireEvent.click(screen.getByRole('button', { name: 'Second cell' }))
    expect(secondCellElement.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
    })

    notebookElement.remove()
  })

  it('shows an outline empty state for notebooks without headings', () => {
    activePanelState = 'outline'
    currentDocUri = 'local://file/outline.json'
    notebookSnapshotState = {
      loaded: true,
      notebook: {
        cells: [
          {
            kind: 1,
            languageId: 'markdown',
            refId: 'cell-one',
            value: 'No headings yet.',
          },
        ],
      },
    }

    render(<SidePanelContent />)

    expect(
      screen.getByText('Add Markdown headings to build an outline.')
    ).toBeTruthy()
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
