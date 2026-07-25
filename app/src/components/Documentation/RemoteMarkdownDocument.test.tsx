// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RemoteMarkdownDocument } from './RemoteMarkdownDocument'

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

describe('RemoteMarkdownDocument', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    mocks.setCurrentDoc.mockReset()
    mocks.showDocument.mockReset()
  })

  it('fetches raw Markdown and opens relative Markdown links in-app', async () => {
    const uri =
      'https://github.com/runmedev/web/blob/abc123/docs/00-getting-started.md'
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        '# Getting Started\n\n[Editing cells](01-editing-and-running-cells.md)',
    }))
    vi.stubGlobal('fetch', fetchMock)

    render(
      <RemoteMarkdownDocument
        document={{
          uri,
          title: 'Getting Started',
          mimeType: 'text/markdown',
          readOnly: true,
        }}
      />
    )

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Getting Started' })
      ).toBeTruthy()
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/runmedev/web/abc123/docs/00-getting-started.md',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )

    fireEvent.click(screen.getByRole('link', { name: 'Editing cells' }))

    const linkedUri =
      'https://github.com/runmedev/web/blob/abc123/docs/01-editing-and-running-cells.md'
    expect(mocks.showDocument).toHaveBeenCalledWith(linkedUri, {
      title: '01-editing-and-running-cells',
      mimeType: 'text/markdown',
      readOnly: true,
    })
    expect(mocks.setCurrentDoc).toHaveBeenCalledWith(linkedUri)
  })
})
