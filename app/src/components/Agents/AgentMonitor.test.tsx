// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { AgentItemView, AgentMonitorOutput } from './AgentMonitor'
import { resetAgentMonitors } from '../../lib/agents/runtime'
import * as runtime from '../../lib/agents/runtime'
import { AgentMonitor } from '../../lib/agents/monitor'
import { keyVault } from '../../lib/keyvault/store'

afterEach(() => {
  cleanup()
  resetAgentMonitors()
  localStorage.clear()
  keyVault.refresh()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
describe('agent monitor rendering', () => {
  it('supports multiline drafts, explicit send, failure retry, and disabled disconnected input', async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined)
    const descriptor = {
      version: 1 as const,
      id: 'composer',
      sessionId: 'sess_composer',
      pageSize: 50,
    }
    const model = new AgentMonitor(descriptor, () => ({
      updateAgent: async () => ({ id: 'agent_test' }),
      createSession: async () => ({ id: 'sess_composer' }),
      sendMessage,
      session: async () => ({ status: 'idle' }),
      turnItems: async () => ({ data: [], has_more: false, last_id: null }),
      items: async () => ({ data: [], has_more: false, last_id: null }),
      turns: async () => ({ data: [], has_more: false, last_id: null }),
      stream: async () => ({
        close() {},
        events: {
          [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
        },
      }),
    }))
    vi.spyOn(runtime, 'resolveAgentMonitor').mockReturnValue(model)
    render(<AgentMonitorOutput value={JSON.stringify(descriptor)} />)
    const input = screen.getByRole('textbox', {
      name: 'Message the agent',
    }) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Hello\nagent' } })
    expect(
      (
        screen.getByRole('button', {
          name: 'Send',
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(model.getSnapshot().connection).toBe('live'))
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(sendMessage).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    await screen.findByRole('alert')
    expect(input.value).toBe('Hello\nagent')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(input.value).toBe(''))
    expect(sendMessage.mock.calls[1][2]).toBe(sendMessage.mock.calls[0][2])
    expect(screen.getByText('Message sent.')).toBeTruthy()
    act(() => model.pause())
  })
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
      'Unlock Key Vault'
    )
    expect(fetch).not.toHaveBeenCalled()
  })
  it('connects a saved widget after unlocking without rerunning its cell', async () => {
    const { webcrypto } = await import('node:crypto')
    vi.stubGlobal('crypto', webcrypto)
    localStorage.clear()
    keyVault.refresh()
    await keyVault.unlock('widget unlock passphrase', true)
    await keyVault.saveKey('openai-api', 'widget-test-secret')
    keyVault.lock()
    const fetchMock = vi.fn<
      (url: string, options?: RequestInit) => Promise<Response>
    >(async (url) => {
      if (url.includes('stream=true'))
        return new Response(new ReadableStream(), {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      return new Response(
        JSON.stringify(
          url.endsWith('sess_saved')
            ? { status: 'idle' }
            : { data: [], has_more: false, last_id: null }
        )
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    render(
      <AgentMonitorOutput
        value={JSON.stringify({
          version: 1,
          id: 'unlock-retry',
          sessionId: 'sess_saved',
          pageSize: 50,
        })}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Unlock Key Vault'
    )
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => {
      await keyVault.unlock('widget unlock passphrase')
    })
    // Unlocking does not issue requests until the user retries Connect.
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        'Connection: live'
      )
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(
      new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')
    ).toBe('Bearer widget-test-secret')
    act(() => keyVault.lock())
    expect(
      screen.getByRole('button', { name: 'Resume monitoring' })
    ).toBeTruthy()
  })
  it('isolates malformed saved descriptors', () => {
    render(<AgentMonitorOutput value='{"version":2}' />)
    expect(screen.getByRole('alert').textContent).toContain('Unsupported')
  })
  it('loads earlier items on scroll and preserves the visible anchor while live output arrives', async () => {
    const descriptor = {
      version: 1 as const,
      id: 'scroll',
      sessionId: 'sess_scroll',
      pageSize: 2,
    }
    const item = (id: string) => ({
      id,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: id }],
    })
    const turnItems = vi.fn(async (_id, _turn, _limit, after) => ({
      data: (after ? ['z', 'y'] : ['b', 'a']).map(item),
      has_more: !after,
      last_id: after ? 'y' : 'a',
    }))
    const model = new AgentMonitor(descriptor, () => ({
      updateAgent: async () => ({}),
      createSession: async () => ({ id: 's' }),
      sendMessage: async () => {},
      session: async () => ({ status: 'idle' }),
      items: async () => {
        throw new Error('must use turn items')
      },
      turnItems,
      turns: async () => ({
        data: [{ id: 't', subagent_id: null }],
        has_more: false,
        last_id: 't',
      }),
      stream: async () => ({
        close() {},
        events: {
          [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
        },
      }),
    }))
    vi.spyOn(runtime, 'resolveAgentMonitor').mockReturnValue(model)
    render(<AgentMonitorOutput value={JSON.stringify(descriptor)} />)
    const viewport = screen.getByTestId('agent-monitor-timeline')
    let top = 0
    const count = () =>
      viewport.querySelectorAll('[data-agent-item-key]').length
    Object.defineProperties(viewport, {
      clientHeight: { get: () => 100 },
      scrollHeight: { get: () => count() * 100 },
      scrollTop: {
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(value, count() * 100 - 100))
        },
      },
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        const index = Array.from(
          viewport.querySelectorAll('[data-agent-item-key]')
        ).indexOf(this)
        const y = this === viewport ? 0 : index * 100 - top
        return {
          top: y,
          bottom: y + 100,
          height: 100,
          left: 0,
          right: 300,
          width: 300,
          x: 0,
          y,
          toJSON() {},
        } as DOMRect
      }
    )
    await act(async () => model.connect())
    expect(top).toBe(100)
    expect(screen.queryByRole('button', { name: /^Older$/ })).toBeNull()
    viewport.scrollTop = 20
    fireEvent.scroll(viewport)
    await waitFor(() => expect(count()).toBe(4))
    expect(top).toBe(220)
    expect(
      viewport
        .querySelector('[data-agent-item-key="a"]')
        ?.getBoundingClientRect().top
    ).toBe(-20)
    expect(turnItems).toHaveBeenLastCalledWith(
      'sess_scroll',
      't',
      2,
      'a',
      expect.any(AbortSignal)
    )
    act(() =>
      model.applyEvent({
        type: 'agent.session.turn.item.added',
        item: item('c'),
      })
    )
    expect(top).toBe(220)
    fireEvent.click(screen.getByRole('button', { name: /^Latest/ }))
    expect(top).toBe(400)
    expect(count()).toBe(5)
    act(() => model.pause())
  })
})
