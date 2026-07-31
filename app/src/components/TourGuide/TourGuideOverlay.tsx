import {
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'
import { XMarkIcon } from '@heroicons/react/20/solid'

import {
  dismissTour,
  tourGuideStore,
  type TourPlacement,
} from '../../lib/tourGuide'

const TARGET_PADDING = 6
const BUBBLE_GAP = 14
const BUBBLE_WIDTH = 320
const VIEWPORT_MARGIN = 12

type BubblePosition = {
  left: number
  top: number
  placement: Exclude<TourPlacement, 'auto'>
}

function findTourTarget(targetId: string): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('[data-tour-id]')).find(
      (element) => element.dataset.tourId === targetId
    ) ?? null
  )
}

function choosePlacement(
  requested: TourPlacement,
  rect: DOMRect
): Exclude<TourPlacement, 'auto'> {
  if (requested !== 'auto') {
    return requested
  }
  if (window.innerWidth - rect.right >= BUBBLE_WIDTH + BUBBLE_GAP) {
    return 'right'
  }
  if (rect.left >= BUBBLE_WIDTH + BUBBLE_GAP) {
    return 'left'
  }
  if (window.innerHeight - rect.bottom >= 180) {
    return 'bottom'
  }
  return 'top'
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function positionBubble(
  rect: DOMRect,
  requested: TourPlacement
): BubblePosition {
  const placement = choosePlacement(requested, rect)
  const centeredTop = rect.top + rect.height / 2 - 80
  const centeredLeft = rect.left + rect.width / 2 - BUBBLE_WIDTH / 2
  let left = rect.right + BUBBLE_GAP
  let top = centeredTop

  if (placement === 'left') {
    left = rect.left - BUBBLE_WIDTH - BUBBLE_GAP
  } else if (placement === 'bottom') {
    left = centeredLeft
    top = rect.bottom + BUBBLE_GAP
  } else if (placement === 'top') {
    left = centeredLeft
    top = rect.top - 174
  }

  return {
    left: clamp(
      left,
      VIEWPORT_MARGIN,
      window.innerWidth - BUBBLE_WIDTH - VIEWPORT_MARGIN
    ),
    top: clamp(top, VIEWPORT_MARGIN, window.innerHeight - 180),
    placement,
  }
}

/**
 * TourGuideOverlay follows the active semantic target as layout changes. It is
 * rendered in a portal so ancestors cannot clip the highlight or annotation.
 */
export default function TourGuideOverlay() {
  const step = useSyncExternalStore(
    tourGuideStore.subscribe,
    tourGuideStore.getSnapshot,
    () => null
  )
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null)

  useLayoutEffect(() => {
    if (!step) {
      setTargetRect(null)
      return
    }

    const target = findTourTarget(step.target)
    if (!target) {
      setTargetRect(null)
      return
    }

    target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const updateRect = () => setTargetRect(target.getBoundingClientRect())
    updateRect()

    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(updateRect)
    resizeObserver?.observe(target)
    window.addEventListener('resize', updateRect)
    window.addEventListener('scroll', updateRect, true)
    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', updateRect)
      window.removeEventListener('scroll', updateRect, true)
    }
  }, [step])

  useEffect(() => {
    if (!step) {
      return
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        dismissTour()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [step])

  if (!step || !targetRect || typeof document === 'undefined') {
    return null
  }

  const bubble = positionBubble(targetRect, step.placement)
  return createPortal(
    <div id="tour-guide-overlay" data-testid="tour-guide-overlay">
      <div
        aria-hidden="true"
        className="pointer-events-none fixed z-[90] rounded-lg border-2 border-amber-400 bg-amber-300/15 shadow-[0_0_0_4px_rgba(251,191,36,0.3),0_0_0_9999px_rgba(15,23,42,0.2)]"
        style={{
          left: targetRect.left - TARGET_PADDING,
          top: targetRect.top - TARGET_PADDING,
          width: targetRect.width + TARGET_PADDING * 2,
          height: targetRect.height + TARGET_PADDING * 2,
        }}
      />
      <section
        role="dialog"
        aria-label={step.title || 'AI tour guide'}
        data-placement={bubble.placement}
        className="fixed z-[91] w-80 rounded-xl border border-amber-200 bg-white p-4 text-nb-text shadow-2xl"
        style={{ left: bubble.left, top: bubble.top }}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold tracking-[0.16em] text-amber-700 uppercase">
              AI tour guide
            </p>
            {step.title ? (
              <h2 className="mt-1 text-base font-semibold text-nb-text">
                {step.title}
              </h2>
            ) : null}
            <p className="mt-2 text-sm leading-6 text-nb-text-muted">
              {step.message}
            </p>
          </div>
          <button
            type="button"
            aria-label="Dismiss tour"
            className="rounded-md p-1 text-nb-text-muted hover:bg-nb-surface-2 hover:text-nb-text"
            onClick={dismissTour}
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
      </section>
    </div>,
    document.body
  )
}
