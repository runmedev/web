// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { tourUiController } from '../lib/tourUiController'
import { SidePanelProvider, useSidePanel } from './SidePanelContext'

function ActivePanel() {
  const { activePanel, togglePanel } = useSidePanel()
  return (
    <button type="button" onClick={() => togglePanel('explorer')}>
      {activePanel ?? 'closed'}
    </button>
  )
}

describe('SidePanelProvider', () => {
  beforeEach(() => {
    window.localStorage.clear()
    tourUiController.resetForTests()
  })

  afterEach(() => {
    cleanup()
    tourUiController.resetForTests()
    window.localStorage.clear()
  })

  it('reacts to imperative controller updates', () => {
    render(
      <SidePanelProvider>
        <ActivePanel />
      </SidePanelProvider>
    )

    expect(screen.getByRole('button').textContent).toBe('explorer')
    act(() => tourUiController.setActivePanel('documentation'))
    expect(screen.getByRole('button').textContent).toBe('documentation')
  })

  it('routes React actions through the same controller', () => {
    render(
      <SidePanelProvider>
        <ActivePanel />
      </SidePanelProvider>
    )

    act(() => screen.getByRole('button').click())
    expect(tourUiController.getSnapshot().activePanel).toBeNull()
  })
})
