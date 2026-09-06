import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  CellChangeInput,
  CellDiscussion,
  DiffCommentComposer,
  ReviewConversation,
} from './ReviewDiscussion'

describe('comment keyboard submission', () => {
  it.each(['change', 'reply', 'selection', 'conversation'])(
    '%s: Enter sends, Shift+Enter and composition do not',
    async (kind) => {
      const onSend = vi.fn(async (_text: string) => true)
      const props = { disabled: false, onSend }
      render(
        kind === 'change' ? (
          <CellChangeInput {...props} label="Comment" />
        ) : kind === 'reply' ? (
          <CellDiscussion
            disabled={false}
            outdated={false}
            thread={{ id: 'thread' }}
            onReply={(_id, text) => onSend(text)}
            onResolve={async () => true}
          />
        ) : kind === 'selection' ? (
          <DiffCommentComposer
            {...props}
            target={{ cellId: 'cell', side: 'head', quote: 'source' }}
            onCancel={() => {}}
          />
        ) : (
          <ReviewConversation {...props} comments={[]} />
        )
      )
      const input = screen.getByRole('textbox') as HTMLTextAreaElement
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(onSend).not.toHaveBeenCalled()
      fireEvent.change(input, { target: { value: 'First line' } })
      expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })).toBe(
        true
      )
      fireEvent.change(input, { target: { value: 'First line\nSecond line' } })
      fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
      fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
      fireEvent.keyDown(input, { key: 'Enter', repeat: true })
      expect(onSend).not.toHaveBeenCalled()
      expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onSend.mock.calls[0][0]).toBe('First line\nSecond line')
      await waitFor(() => expect(input.value).toBe(''))
    }
  )

  it('guards in-flight sends and retains failed or subsequently edited drafts', async () => {
    let finish!: (success: boolean) => void
    const onSend = vi.fn(
      (_text: string) =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        })
    )
    const { rerender } = render(
      <CellChangeInput label="Comment" disabled={false} onSend={onSend} />
    )
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Draft' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Send comment' }))
    expect(onSend).toHaveBeenCalledTimes(1)
    await act(async () => finish(false))
    expect(input.value).toBe('Draft')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(2)
    fireEvent.change(input, { target: { value: 'Another draft' } })
    await act(async () => finish(true))
    expect(input.value).toBe('Another draft')
    rerender(<CellChangeInput label="Comment" disabled onSend={onSend} />)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(2)
  })
})
