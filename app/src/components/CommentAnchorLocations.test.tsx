import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CommentAnchorLocations } from './CommentAnchorLocations'
import type { LocatedAnchor } from '../lib/commentAnchorMapping'

function location(start: number, end: number, cell = 'cell-1'): LocatedAnchor {
  return {
    anchor: {
      kind: 'cell',
      cell_id: cell,
      surface: 'source',
      selection_surface: 'rendered-markdown',
      version: { kind: 'revision', revision_id: 'r1' },
      range: { start_index: start, end_index: end },
    },
    source: 'hello **world** and more',
    location: { status: 'exact', start, end },
  }
}

describe('CommentAnchorLocations', () => {
  it('combines adjacent pieces of a selection and navigates to the whole range', () => {
    const select = vi.fn()
    render(
      <CommentAnchorLocations
        locations={[location(0, 6), location(8, 13)]}
        onSelect={select}
      />
    )
    const buttons = screen.getAllByRole('button', { name: /Located/ })
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0]!)
    expect(select.mock.calls[0]![0].location).toEqual({
      status: 'exact',
      start: 0,
      end: 13,
    })
  })

  it('retains separate navigation for distant ranges and different cells', () => {
    render(
      <CommentAnchorLocations
        locations={[location(0, 5), location(18, 22), location(0, 5, 'cell-2')]}
        onSelect={() => {}}
      />
    )
    expect(screen.getAllByRole('button', { name: /Located/ })).toHaveLength(3)
  })
})
