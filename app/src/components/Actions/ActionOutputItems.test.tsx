import { create } from '@bufbuild/protobuf'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { parser_pb } from '../../runme/client'
import { ActionOutputItems } from './ActionOutputItems'

it('shows output content without headers and copies the original item through its icon', () => {
  const copy = vi.fn()
  render(
    <ActionOutputItems
      outputs={[
        create(parser_pb.CellOutputSchema, {
          items: [
            { mime: 'text/plain', data: new Uint8Array() },
            {
              mime: 'text/plain',
              data: new TextEncoder().encode('Baseline: 42'),
            },
          ],
        }),
      ]}
      onCopyReference={copy}
    />
  )
  expect(screen.getByTestId('cell-output-item').textContent).toBe(
    'Baseline: 42'
  )
  const button = screen.getByRole('button', { name: 'Copy output link 0.1' })
  expect(button.textContent).toBe('')
  fireEvent.click(button)
  expect(copy).toHaveBeenCalledWith(0, 1)
})
