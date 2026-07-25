// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  GETTING_STARTED_OPENED_STORAGE_KEY,
  getGettingStartedDocument,
} from '../../lib/documentation'
import { DocumentationInitializer } from './DocumentationInitializer'

const mocks = vi.hoisted(() => ({
  setCurrentDoc: vi.fn(),
  showDocument: vi.fn(),
}))

vi.mock('../../contexts/CurrentDocContext', () => ({
  useCurrentDoc: () => ({
    setCurrentDoc: mocks.setCurrentDoc,
  }),
}))

vi.mock('../../contexts/WorkspaceDocumentContext', () => ({
  useWorkspaceDocumentContext: () => ({
    showDocument: mocks.showDocument,
  }),
}))

describe('DocumentationInitializer', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.history.replaceState(null, '', '/')
    mocks.setCurrentDoc.mockReset()
    mocks.showDocument.mockReset()
  })

  it('opens Getting Started once for a first-time user', () => {
    const document = getGettingStartedDocument()

    const { unmount } = render(<DocumentationInitializer />)

    expect(mocks.showDocument).toHaveBeenCalledWith(document.uri, {
      title: 'Getting Started',
      mimeType: 'text/markdown',
      readOnly: true,
    })
    expect(mocks.setCurrentDoc).toHaveBeenCalledWith(document.uri)
    expect(
      window.localStorage.getItem(GETTING_STARTED_OPENED_STORAGE_KEY)
    ).toBe('true')

    unmount()
    mocks.showDocument.mockClear()
    render(<DocumentationInitializer />)
    expect(mocks.showDocument).not.toHaveBeenCalled()
  })

  it('does not replace an explicit doc URL', () => {
    window.history.replaceState(
      null,
      '',
      '/?doc=local%3A%2F%2Ffile%2Frequested'
    )

    const view = render(<DocumentationInitializer />)
    window.history.replaceState(null, '', '/')
    view.rerender(<DocumentationInitializer />)

    expect(mocks.showDocument).not.toHaveBeenCalled()
    expect(
      window.localStorage.getItem(GETTING_STARTED_OPENED_STORAGE_KEY)
    ).toBeNull()
  })
})
