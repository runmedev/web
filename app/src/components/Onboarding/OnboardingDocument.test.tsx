// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  markOnboardingNotebookCreated,
  ONBOARDING_STORAGE_KEY,
} from '../../lib/onboarding'
import { OnboardingDocument } from './OnboardingDocument'

const mocks = vi.hoisted(() => ({
  copyNotebookMarkdownLink: vi.fn(),
  showToast: vi.fn(),
}))

vi.mock('../../contexts/CurrentDocContext', () => ({
  useCurrentDoc: () => ({ setCurrentDoc: vi.fn() }),
}))

vi.mock('../../contexts/GoogleAuthContext', () => ({
  useGoogleAuth: () => ({ startGoogleDriveOAuth: vi.fn() }),
}))

vi.mock('../../contexts/SidePanelContext', () => ({
  useSidePanel: () => ({ setPanel: vi.fn() }),
}))

vi.mock('../../contexts/WorkspaceDocumentContext', () => ({
  useWorkspaceDocumentContext: () => ({
    showDocument: vi.fn(),
    closeWorkspaceDocument: vi.fn(),
  }),
}))

vi.mock('../Workspace/GoogleDrivePickerButton', () => ({
  GoogleDrivePickerButton: ({ label }: { label: string }) => (
    <button type="button">{label}</button>
  ),
}))

vi.mock('../../lib/shareLinks', () => ({
  copyNotebookMarkdownLink: mocks.copyNotebookMarkdownLink,
}))

vi.mock('../../lib/toast', () => ({
  showToast: mocks.showToast,
}))

describe('OnboardingDocument sharing step', () => {
  beforeEach(() => {
    window.localStorage.clear()
    mocks.copyNotebookMarkdownLink.mockReset()
    mocks.copyNotebookMarkdownLink.mockResolvedValue(
      '[latest](http://localhost/?doc=drive)'
    )
    mocks.showToast.mockReset()
  })

  it('offers Codex a machine-independent sample task', () => {
    render(<OnboardingDocument />)

    expect(
      screen.getByRole('heading', { name: 'Document What Codex Does' })
    ).toBeTruthy()
    expect(
      screen.getByText(
        'Open https://web.runme.dev in @Browser. Create a notebook that documents how to convert Celsius to Fahrenheit. Add and run a JavaScript cell that converts 20°C, then explain the result.'
      )
    ).toBeTruthy()
  })

  it('enables Copy Link for the most recently created Drive notebook', async () => {
    render(<OnboardingDocument />)

    expect(
      (screen.getByRole('button', { name: 'Copy Link' }) as HTMLButtonElement)
        .disabled
    ).toBe(true)

    act(() => {
      markOnboardingNotebookCreated({
        uri: 'local://file/latest',
        name: 'latest.json',
        remoteUri: 'https://drive.google.com/file/d/latest/view',
      })
    })

    const button = screen.getByRole('button', { name: 'Copy Link' })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button)

    await waitFor(() => {
      expect(mocks.copyNotebookMarkdownLink).toHaveBeenCalledWith(
        'latest.json',
        'https://drive.google.com/file/d/latest/view'
      )
    })
    expect(mocks.showToast).toHaveBeenCalledWith({
      message: 'Markdown link copied',
      tone: 'success',
    })
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toContain(
      'latest.json'
    )
  })
})
