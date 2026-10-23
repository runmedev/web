import { create } from '@bufbuild/protobuf'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../../runme/client'
import type LocalNotebooks from '../../storage/local'
import type { ResolvedOutputReference } from '../../lib/outputReference'
import { OutputReferenceCell } from './OutputReferenceCell'

const cell = create(parser_pb.CellSchema, {
  refId: 'ref',
  kind: parser_pb.CellKind.MARKUP,
  languageId: 'runme-reference',
  value:
    '<a href="#cell=methods&amp;version=operation%3Av1&amp;output_item=0.0">Table</a>',
})

/** Keep promises pending so tests can observe graph identity during sync. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function historicalOutput(text = 'old'): ResolvedOutputReference {
  return {
    item: create(parser_pb.CellOutputItemSchema, {
      mime: 'text/html',
      data: new TextEncoder().encode(`<p>${text}</p>`),
    }),
    executionId: 'E1',
    status: 'succeeded',
    source: 'print("old")',
    sourceOperationId: 'R1',
    language: 'python',
  }
}

describe('OutputReferenceCell', () => {
  it('keeps the same interactive output mounted across notebook sync notifications', async () => {
    let notify = () => {}
    const store = {
      resolveOutputReference: vi.fn().mockResolvedValue(historicalOutput()),
      subscribeSync: vi.fn((_uri, callback) => {
        notify = callback
        return () => {}
      }),
    }
    const props = {
      cell,
      uri: 'local://file/test',
      store: store as unknown as LocalNotebooks,
      readOnly: false,
      onChange: vi.fn(),
    }
    const { rerender } = render(<OutputReferenceCell {...props} />)
    const frame = await screen.findByTitle('cell-output-0-0')
    // Notebook snapshots clone cells on edits; neither clones nor sync events
    // from deleting an unrelated cell should replace the chart's iframe.
    rerender(
      <OutputReferenceCell
        {...props}
        cell={create(parser_pb.CellSchema, cell)}
      />
    )
    await act(async () => {
      notify()
      notify()
    })
    expect(screen.queryByText('Loading referenced output…')).toBeNull()
    expect(screen.getByTitle('cell-output-0-0')).toBe(frame)
    expect(store.resolveOutputReference).toHaveBeenCalledTimes(1)
  })

  it('recovers missing history arriving during a lookup without overlapping requests', async () => {
    let notify = () => {}
    const first = deferred<ResolvedOutputReference>()
    const store = {
      resolveOutputReference: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValue(historicalOutput()),
      subscribeSync: vi.fn((_uri, callback) => {
        notify = callback
        return () => {}
      }),
    }
    render(
      <OutputReferenceCell
        cell={cell}
        uri="local://file/test"
        store={store as unknown as LocalNotebooks}
        readOnly={false}
        onChange={vi.fn()}
      />
    )
    await act(async () => {
      notify()
      notify()
    })
    expect(store.resolveOutputReference).toHaveBeenCalledTimes(1)
    await act(async () => first.reject(new Error('Missing history')))
    await screen.findByTitle('cell-output-0-0')
    expect(store.resolveOutputReference).toHaveBeenCalledTimes(2)
    await act(async () => notify())
    expect(store.resolveOutputReference).toHaveBeenCalledTimes(2)
  })

  it('keeps output mounted while retrying incomplete provenance, including retry failures', async () => {
    let notify = () => {}
    const retry = deferred<ResolvedOutputReference>()
    const store = {
      resolveOutputReference: vi
        .fn()
        .mockResolvedValueOnce({
          ...historicalOutput(),
          provenanceError: 'Missing source',
        })
        .mockReturnValueOnce(retry.promise)
        .mockResolvedValue(historicalOutput()),
      subscribeSync: vi.fn((_uri, callback) => {
        notify = callback
        return () => {}
      }),
    }
    render(
      <OutputReferenceCell
        cell={cell}
        uri="local://file/test"
        store={store as unknown as LocalNotebooks}
        readOnly={false}
        onChange={vi.fn()}
      />
    )
    const frame = await screen.findByTitle('cell-output-0-0')
    fireEvent.click(screen.getByRole('button', { name: 'View executed code' }))
    expect(screen.getByText('Missing source')).toBeTruthy()
    await act(async () => notify())
    expect(screen.queryByText('Loading referenced output…')).toBeNull()
    expect(screen.getByTitle('cell-output-0-0')).toBe(frame)
    await act(async () =>
      retry.reject(new Error('Storage temporarily unavailable'))
    )
    expect(screen.getByTitle('cell-output-0-0')).toBe(frame)
    await act(async () => notify())
    await screen.findByLabelText('Executed code')
    expect(screen.queryByText('Missing source')).toBeNull()
    expect(screen.getByTitle('cell-output-0-0')).toBe(frame)
    await act(async () => notify())
    expect(store.resolveOutputReference).toHaveBeenCalledTimes(3)
  })

  it.each(['link', 'uri', 'store'] as const)(
    'resolves a changed %s and ignores the previous lookup',
    async (changed) => {
      const stale = deferred<ResolvedOutputReference>()
      const next = deferred<ResolvedOutputReference>()
      const store = {
        resolveOutputReference: vi
          .fn()
          .mockReturnValueOnce(stale.promise)
          .mockReturnValue(next.promise),
        subscribeSync: vi.fn(),
      }
      const otherStore = {
        resolveOutputReference: vi.fn().mockReturnValue(next.promise),
        subscribeSync: vi.fn(),
      }
      const props = {
        cell,
        uri: 'local://file/test',
        store: store as unknown as LocalNotebooks,
        readOnly: false,
        onChange: vi.fn(),
      }
      const { rerender } = render(<OutputReferenceCell {...props} />)
      rerender(
        <OutputReferenceCell
          {...props}
          cell={
            changed === 'link'
              ? create(parser_pb.CellSchema, {
                  ...cell,
                  value: cell.value.replace('v1', 'v2'),
                })
              : cell
          }
          uri={changed === 'uri' ? 'local://file/other' : props.uri}
          store={
            changed === 'store'
              ? (otherStore as unknown as LocalNotebooks)
              : props.store
          }
        />
      )
      await act(async () => next.resolve(historicalOutput('new')))
      const frame = await screen.findByTitle('cell-output-0-0')
      expect(frame.getAttribute('srcdoc')).toContain('new')
      await act(async () => stale.resolve(historicalOutput('stale')))
      expect(screen.getByTitle('cell-output-0-0')).toBe(frame)
      expect(frame.getAttribute('srcdoc')).not.toContain('stale')
    }
  )

  it('renders one historical output and read-only executed source', async () => {
    const store = {
      resolveOutputReference: vi.fn().mockResolvedValue({
        item: create(parser_pb.CellOutputItemSchema, {
          mime: 'text/plain',
          data: new Uint8Array([111, 108, 100]),
        }),
        executionId: 'E1',
        status: 'succeeded',
        source: 'print("old")',
        sourceOperationId: 'R1',
        language: 'python',
      }),
      subscribeSync: vi.fn(),
    }
    render(
      <OutputReferenceCell
        cell={cell}
        uri="local://file/test"
        store={store as unknown as LocalNotebooks}
        readOnly={false}
        onChange={vi.fn()}
      />
    )
    await screen.findByText('old')
    expect(screen.queryByLabelText('Executed code')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'View executed code' }))
    expect(
      screen
        .getByLabelText('Executed code')
        .compareDocumentPosition(screen.getByTestId('cell-output-item')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(screen.getByLabelText('Executed code').textContent).toBe(
      'print("old")'
    )
    expect(screen.queryByRole('button', { name: 'Run code' })).toBeNull()
    expect(store.resolveOutputReference).toHaveBeenCalledWith(
      'local://file/test',
      cell.value
    )
  })
  it('keeps corrupt references editable and retries after history arrives', async () => {
    let notify: () => void = () => {}
    const store = {
      resolveOutputReference: vi
        .fn()
        .mockRejectedValue(new Error('Missing version')),
      subscribeSync: vi.fn((_uri, callback) => {
        notify = callback
        return () => {}
      }),
    }
    const change = vi.fn()
    render(
      <OutputReferenceCell
        cell={cell}
        uri="local://file/test"
        store={store as unknown as LocalNotebooks}
        readOnly={false}
        onChange={change}
      />
    )
    await screen.findByRole('alert')
    fireEvent.doubleClick(screen.getByTestId('output-reference-cell'))
    fireEvent.change(screen.getByLabelText('Output reference source'), {
      target: { value: 'corrected link' },
    })
    expect(change).toHaveBeenCalledWith('corrected link')
    await act(async () => notify())
    await waitFor(() =>
      expect(store.resolveOutputReference).toHaveBeenCalledTimes(2)
    )
  })

  it('double-clicks into a focused editor and Escape renders without discarding changes', async () => {
    const store = {
      resolveOutputReference: vi
        .fn()
        .mockRejectedValue(new Error('Missing version')),
      subscribeSync: vi.fn(),
    }
    const change = vi.fn()
    render(
      <OutputReferenceCell
        cell={cell}
        uri="local://file/test"
        store={store as unknown as LocalNotebooks}
        readOnly={false}
        onChange={change}
      />
    )
    await screen.findByRole('alert')
    fireEvent.doubleClick(screen.getByTestId('output-reference-cell'))
    const editor = screen.getByLabelText('Output reference source')
    expect(document.activeElement).toBe(editor)
    fireEvent.change(editor, { target: { value: 'edited reference' } })
    fireEvent.keyDown(editor, { key: 'Escape' })
    expect(screen.queryByLabelText('Output reference source')).toBeNull()
    expect(change).toHaveBeenLastCalledWith('edited reference')
    fireEvent.doubleClick(screen.getByTestId('output-reference-cell'))
    expect(
      (screen.getByLabelText('Output reference source') as HTMLTextAreaElement)
        .value
    ).toBe('edited reference')
  })

  it('does not enter edit mode for read-only references', async () => {
    const store = {
      resolveOutputReference: vi
        .fn()
        .mockRejectedValue(new Error('Missing version')),
      subscribeSync: vi.fn(),
    }
    render(
      <OutputReferenceCell
        cell={cell}
        uri="local://file/test"
        store={store as unknown as LocalNotebooks}
        readOnly
        onChange={vi.fn()}
      />
    )
    await screen.findByRole('alert')
    fireEvent.doubleClick(screen.getByTestId('output-reference-cell'))
    expect(screen.queryByLabelText('Output reference source')).toBeNull()
  })
})
