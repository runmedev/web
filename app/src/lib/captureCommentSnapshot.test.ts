import { expect, it, vi } from 'vitest'

import { captureCommentSnapshot } from './captureCommentSnapshot'

it('captures committed visible heads and rejects edits during persistence', async () => {
  let cells = ['selected text'],
    heads = ['a:1']
  const data = {
    getNotebook: () => ({ cells }),
    getObservedOperationHeads: () => heads,
    flushPendingPersist: vi.fn(async () => {
      heads = ['a:2']
    }),
  }
  const captured = await captureCommentSnapshot(data)
  heads.push('a:3')
  expect(captured).toEqual(['a:2'])
  data.flushPendingPersist.mockImplementation(async () => {
    cells = ['unseen text']
  })
  await expect(captureCommentSnapshot(data)).rejects.toThrow('notebook changed')
})

it('does not silently bind a comment to the send-time head when capture is unavailable', async () => {
  await expect(
    captureCommentSnapshot({ getNotebook: () => ({ cells: [] }) })
  ).rejects.toThrow('revision is unavailable')
})
