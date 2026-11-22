// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getDocumentationEntry,
  getGettingStartedDocument,
} from '../../lib/documentation'
import { DocumentationExplorer } from './DocumentationExplorer'

const mocks = vi.hoisted(() => ({
  setCurrentDoc: vi.fn(),
  showDocument: vi.fn(),
}))

vi.mock('../../contexts/CurrentDocContext', () => ({
  useCurrentDoc: () => ({
    getCurrentDoc: () => null,
    setCurrentDoc: mocks.setCurrentDoc,
  }),
}))

vi.mock('../../contexts/WorkspaceDocumentContext', () => ({
  useWorkspaceDocumentContext: () => ({
    showDocument: mocks.showDocument,
  }),
}))

describe('DocumentationExplorer', () => {
  beforeEach(() => {
    window.localStorage.clear()
    mocks.setCurrentDoc.mockReset()
    mocks.showDocument.mockReset()
  })

  it('opens Keyboard Shortcuts while the User Guide is collapsed', () => {
    const entry = getDocumentationEntry('keyboard-shortcuts')
    render(<DocumentationExplorer />)
    const guide = screen.getByRole('treeitem', { name: 'User Guide' })
    const shortcuts = screen.getByRole('treeitem', {
      name: 'Keyboard Shortcuts',
    })
    expect(shortcuts.parentElement).toBe(guide.parentElement)
    fireEvent.click(guide)
    expect(
      screen.queryByRole('treeitem', { name: 'Getting Started' })
    ).toBeNull()
    fireEvent.click(shortcuts)
    expect(mocks.showDocument).toHaveBeenCalledWith(entry.uri, {
      title: 'Keyboard Shortcuts',
      mimeType: 'text/markdown',
      readOnly: true,
    })
    expect(mocks.setCurrentDoc).toHaveBeenCalledWith(entry.uri)
  })

  it('renders a documentation tree and opens a selected page read-only', () => {
    const gettingStarted = getGettingStartedDocument()
    render(<DocumentationExplorer />)

    expect(
      screen.getByRole('tree', { name: 'Runme documentation' })
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('treeitem', { name: 'Getting Started' }))

    expect(mocks.showDocument).toHaveBeenCalledWith(gettingStarted.uri, {
      title: 'Getting Started',
      mimeType: 'text/markdown',
      readOnly: true,
    })
    expect(mocks.setCurrentDoc).toHaveBeenCalledWith(gettingStarted.uri)
  })
})
