// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AgentItemView, AgentMonitorOutput } from './AgentMonitor'
import { resetAgentMonitors } from '../../lib/agents/runtime'

afterEach(() => {
  cleanup()
  resetAgentMonitors()
  vi.unstubAllGlobals()
})
describe('agent monitor rendering', () => {
  it('renders Markdown tables and code without executing HTML or loading images', () => {
    const { container } = render(
      <AgentItemView
        item={{
          id: 'message',
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: '**Done**\n\n|Result|Count|\n|---|---|\n|Passed|5|\n\n```js\nalert(1)\n```\n\n<script>alert(2)</script>\n\n![tracking](https://example.com/image.png)\n\n[bad](javascript:alert(3))',
            },
          ],
        }}
      />
    )
    expect(container.querySelector('strong')?.textContent).toBe('Assistant')
    expect(container.querySelector('table')?.textContent).toContain('Passed')
    expect(container.querySelector('pre code')?.textContent).toContain(
      'alert(1)'
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('a')?.getAttribute('href')).not.toMatch(
      /^javascript:/
    )
  })
  it('keeps unknown tool payloads inspectable and distinguishes user messages', () => {
    render(
      <>
        <AgentItemView
          item={{
            id: 'tool',
            type: 'future_tool',
            status: 'failed',
            detail: 'Diagnostic',
          }}
        />
        <AgentItemView
          item={{
            id: null,
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Hello' }],
          }}
        />
      </>
    )
    expect(screen.getByText('future_tool · failed')).toBeTruthy()
    expect(screen.getByText('You')).toBeTruthy()
  })
  it('does not connect saved output automatically and gives actionable configuration errors', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    render(
      <AgentMonitorOutput
        value={JSON.stringify({
          version: 1,
          id: 'saved',
          sessionId: 'sess_saved',
          pageSize: 50,
        })}
      />
    )
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'agents.setKey'
    )
    expect(fetch).not.toHaveBeenCalled()
  })
  it('isolates malformed saved descriptors', () => {
    render(<AgentMonitorOutput value='{"version":2}' />)
    expect(screen.getByRole('alert').textContent).toContain('Unsupported')
  })
})
