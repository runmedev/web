import { create } from '@bufbuild/protobuf'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { parser_pb } from '../../runme/client'
import { ReviewScopePicker } from './ReviewScopePicker'

describe('review outline scope picker', () => {
  it('offers deleted sections from the start outline and does not silently select all when headings are missing', () => {
    const before = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          refId: 'gone',
          kind: parser_pb.CellKind.MARKUP,
          value: '## Deleted section',
        }),
        create(parser_pb.CellSchema, {
          refId: 'body',
          kind: parser_pb.CellKind.CODE,
          value: 'do work',
        }),
      ],
    })
    const after = create(parser_pb.NotebookSchema, { cells: [] })
    const onChange = vi.fn()
    render(
      <ReviewScopePicker
        before={before}
        after={after}
        disabled={false}
        onChange={onChange}
      />
    )
    fireEvent.click(
      screen.getByRole('radio', { name: 'Heading / section range' })
    )
    expect(onChange).toHaveBeenLastCalledWith([])
    expect(screen.getByRole('status').textContent).toContain('No headings')
    fireEvent.change(screen.getByLabelText('Scope outline revision'), {
      target: { value: 'base' },
    })
    expect(onChange).toHaveBeenLastCalledWith(['gone', 'body'])
    expect(screen.getByLabelText('From heading').textContent).toContain(
      'Deleted section'
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Whole document' }))
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })
})
