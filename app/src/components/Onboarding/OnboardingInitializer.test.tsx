// @vitest-environment jsdom
import { captureStartupDocumentRequest } from '../../lib/startupNavigation'

import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ONBOARDING_DOCUMENT_URI,
  ONBOARDING_MIME_TYPE,
  ONBOARDING_STORAGE_KEY,
} from '../../lib/onboarding'
import { OnboardingInitializer } from './OnboardingInitializer'

const mocks = vi.hoisted(() => ({
  currentDoc: null as string | null,
  setCurrentDoc: vi.fn(),
  showDocument: vi.fn(),
}))

vi.mock('../../contexts/CurrentDocContext', () => ({
  useCurrentDoc: () => ({
    getCurrentDoc: () => mocks.currentDoc,
    setCurrentDoc: mocks.setCurrentDoc,
  }),
}))

vi.mock('../../contexts/WorkspaceDocumentContext', () => ({
  useWorkspaceDocumentContext: () => ({
    showDocument: mocks.showDocument,
  }),
}))

describe('OnboardingInitializer', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.history.replaceState(null, '', '/')
    captureStartupDocumentRequest()
    mocks.currentDoc = null
    mocks.setCurrentDoc.mockReset()
    mocks.showDocument.mockReset()
  })

  it('opens onboarding as a document on the first visit', () => {
    render(<OnboardingInitializer />)

    expect(mocks.showDocument).toHaveBeenCalledWith(ONBOARDING_DOCUMENT_URI, {
      title: 'Welcome to Runme',
      mimeType: ONBOARDING_MIME_TYPE,
      readOnly: true,
    })
    expect(mocks.setCurrentDoc).toHaveBeenCalledWith(ONBOARDING_DOCUMENT_URI)
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toContain(
      '"opened":true'
    )
  })

  it('opens in the background without replacing restored work', () => {
    mocks.currentDoc = 'local://file/restored.json'

    render(<OnboardingInitializer />)

    expect(mocks.showDocument).toHaveBeenCalledOnce()
    expect(mocks.setCurrentDoc).not.toHaveBeenCalled()
  })

  it('does not open again or replace an explicit doc URL', () => {
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        opened: true,
        dismissed: true,
        completedTaskIds: [],
      })
    )
    render(<OnboardingInitializer />)
    expect(mocks.showDocument).not.toHaveBeenCalled()

    window.localStorage.clear()
    window.history.replaceState(
      null,
      '',
      '/?doc=local%3A%2F%2Ffile%2Frequested'
    )
    render(<OnboardingInitializer />)
    expect(mocks.showDocument).not.toHaveBeenCalled()
  })
  it('preserves explicit navigation after bootstrap consumes its URL', () => {
    window.history.replaceState(
      null,
      '',
      '/?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2Fshared%2Fview'
    )
    captureStartupDocumentRequest()
    window.history.replaceState(null, '', '/?session=restored')
    render(<OnboardingInitializer />)
    expect(mocks.showDocument).not.toHaveBeenCalled()
    expect(mocks.setCurrentDoc).not.toHaveBeenCalled()
  })
})
