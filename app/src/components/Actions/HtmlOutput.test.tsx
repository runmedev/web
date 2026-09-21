import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { HtmlOutput } from './HtmlOutput'

describe('isolated HTML sizing', () => {
  it('accepts only matching frame messages, bounds height and preserves isolation', () => {
    render(
      <HtmlOutput
        html="<table><tr><td>Report</td></tr></table>"
        title="table"
      />
    )
    const frame = screen.getByTitle('table') as HTMLIFrameElement
    const nonce = frame.srcdoc.match(/nonce:"([^"]+)"/)![1]
    const send = (source: Window | null, height: number, token = nonce) =>
      act(() =>
        window.dispatchEvent(
          new MessageEvent('message', {
            source,
            data: { type: 'runme-output-height', nonce: token, height },
          })
        )
      )
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    send(window, 40)
    expect(frame.style.height).toBe('120px')
    send(frame.contentWindow, 40, 'wrong')
    expect(frame.style.height).toBe('120px')
    send(frame.contentWindow, 40)
    expect(frame.style.height).toBe('60px')
    send(frame.contentWindow, Infinity)
    expect(frame.style.height).toBe('60px')
    send(frame.contentWindow, 100000)
    expect(frame.style.height).toBe('2000px')
    expect(screen.getByRole('button', { name: 'Expand output' })).toBeDefined()
  })
})
