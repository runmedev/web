// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { CommentedSourceRun } from './CommentedSourceRun'
it('underlines exactly the source slice and opens the same thread', () => {
  const select = vi.fn()
  const { container } = render(
    <span data-diff-run="" data-base-offset="0">
      <CommentedSourceRun
        value="before 😀 after"
        base={0}
        ranges={[{ start: 7, end: 9, side: 'base', threadId: 'thread' }]}
        onSelect={select}
      />
    </span>
  )
  expect(container.textContent).toBe('before 😀 after')
  const mark = screen.getByRole('button', { name: 'Open comment on this text' })
  expect(mark.textContent).toBe('😀')
  fireEvent.keyDown(mark, { key: 'Enter' })
  expect(select).toHaveBeenCalledWith('thread')
})
