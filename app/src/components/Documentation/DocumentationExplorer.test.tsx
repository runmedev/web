// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getGettingStartedDocument } from '../../lib/documentation'
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
