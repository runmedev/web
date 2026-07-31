// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { dismissTour, showTourStep } from '../../lib/tourGuide'
import TourGuideOverlay from './TourGuideOverlay'

function addTarget(targetId: string, top: number): HTMLElement {
  const target = document.createElement('button')
  target.dataset.tourId = targetId
  target.getBoundingClientRect = () =>
    ({
      left: 10,
      top,
      right: 50,
      bottom: top + 40,
      width: 40,
      height: 40,
      x: 10,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect
  document.body.appendChild(target)
  return target
}

describe('TourGuideOverlay', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
  })

  afterEach(() => {
    cleanup()
    dismissTour()
  })

  it('highlights the target and renders the AI annotation', () => {
    const target = addTarget('left-nav.google-drive', 120)
    render(<TourGuideOverlay />)

    act(() => {
      showTourStep({
        target: 'left-nav.google-drive',
        title: 'Sign in to Google Drive',
        message: 'Click this button to connect Google Drive.',
      })
    })

    expect(screen.getByRole('dialog').textContent).toContain(
      'Click this button to connect Google Drive.'
    )
    expect(screen.getByTestId('tour-guide-overlay')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss tour' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    target.remove()
  })

  it('dismisses the annotation with Escape', () => {
    const target = addTarget('left-nav.explorer', 10)
    render(<TourGuideOverlay />)
    act(() => {
      showTourStep({
        target: 'left-nav.explorer',
        message: 'Browse files here.',
      })
    })

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).toBeNull()
    target.remove()
  })

  it('replaces the visible highlight and annotation for the next step', () => {
    const explorer = addTarget('left-nav.explorer', 10)
    const documents = addTarget('left-nav.open-documents', 80)
    render(<TourGuideOverlay />)

    act(() => {
      showTourStep({
        target: 'left-nav.explorer',
        message: 'Browse files here.',
      })
    })
    act(() => {
      showTourStep({
        target: 'left-nav.open-documents',
        message: 'See open documents here.',
      })
    })

    expect(screen.getAllByTestId('tour-guide-overlay')).toHaveLength(1)
    expect(screen.getByRole('dialog').textContent).toContain(
      'See open documents here.'
    )
    expect(screen.getByRole('dialog').textContent).not.toContain(
      'Browse files here.'
    )
    explorer.remove()
    documents.remove()
  })
})
