// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { APP_CONSOLE_DOCUMENT_URI } from '../workspaceDocuments/workspaceDocumentTypes'
import {
  __resetAppConsoleDataForTests,
  getAppConsoleData,
} from './appConsoleController'
import { useAppConsoleRunner } from './useAppConsoleRunner'

const mocks = vi.hoisted(() => ({
  showDocument: vi.fn(),
  setCurrentDoc: vi.fn(),
}))

vi.mock('../../contexts/WorkspaceDocumentContext', () => ({
  useWorkspaceDocumentContext: () => ({ showDocument: mocks.showDocument }),
}))

vi.mock('../../contexts/CurrentDocContext', () => ({
  useCurrentDoc: () => ({ setCurrentDoc: mocks.setCurrentDoc }),
}))

describe('useAppConsoleRunner', () => {
  beforeEach(() => {
    __resetAppConsoleDataForTests()
    mocks.showDocument.mockReset()
    mocks.setCurrentDoc.mockReset()
  })

  afterEach(() => {
    __resetAppConsoleDataForTests()
  })

  it('queues the snippet and opens and focuses the App Console', () => {
    const { result } = renderHook(() => useAppConsoleRunner())

    result.current.createAndRun('runme.help()')

    expect(getAppConsoleData().takePendingRunRequests()).toEqual([
      'runme.help()',
    ])
    expect(mocks.showDocument).toHaveBeenCalledWith(APP_CONSOLE_DOCUMENT_URI, {
      title: 'App Console',
    })
    expect(mocks.setCurrentDoc).toHaveBeenCalledWith(APP_CONSOLE_DOCUMENT_URI)
  })

  it('does nothing for blank snippets', () => {
    const { result } = renderHook(() => useAppConsoleRunner())

    result.current.createAndRun('   ')

    expect(getAppConsoleData().takePendingRunRequests()).toEqual([])
    expect(mocks.showDocument).not.toHaveBeenCalled()
    expect(mocks.setCurrentDoc).not.toHaveBeenCalled()
  })
})
