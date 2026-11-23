import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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
  it('shows one historical disclosure for outdated fragments and keeps their excerpts', () => {
    const locations = [location(0, 5), location(8, 13)].map((entry) => ({
      ...entry,
      location: { status: 'outdated' as const },
    }))
    render(<CommentAnchorLocations locations={locations} />)
    expect(screen.getAllByText(/has changed since you commented/)).toHaveLength(
      1
    )
    fireEvent.click(screen.getByText('View original passages'))
    expect(screen.getByText('hello')).toBeTruthy()
    expect(screen.getByText('world')).toBeTruthy()
  })

  it('retains separate navigation for independent nearby ranges and different cells', () => {
    render(
      <CommentAnchorLocations
        locations={[location(0, 5), location(8, 13), location(0, 5, 'cell-2')]}
        onSelect={() => {}}
      />
    )
    expect(screen.getAllByRole('button', { name: /Located/ })).toHaveLength(3)
  })
})
