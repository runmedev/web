import { create } from '@bufbuild/protobuf'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../../runme/client'
import type LocalNotebooks from '../../storage/local'
import { OutputReferenceCell } from './OutputReferenceCell'

const cell = create(parser_pb.CellSchema, {
  refId: 'ref',
  kind: parser_pb.CellKind.MARKUP,
  languageId: 'runme-reference',
  value:
    '<a href="#cell=methods&amp;version=operation%3Av1&amp;output_item=0.0">Table</a>',
})

describe('OutputReferenceCell', () => {
  it('renders one historical output and read-only executed source', async () => {
    const store = {
      resolveOutputReference: vi
        .fn()
        .mockResolvedValue({
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
    fireEvent.click(screen.getByRole('button', { name: 'Edit reference' }))
    fireEvent.change(screen.getByLabelText('Output reference source'), {
      target: { value: 'corrected link' },
    })
    expect(change).toHaveBeenCalledWith('corrected link')
    await act(async () => notify())
    await waitFor(() =>
      expect(store.resolveOutputReference).toHaveBeenCalledTimes(2)
    )
  })
})
