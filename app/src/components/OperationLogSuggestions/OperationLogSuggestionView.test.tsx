import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createRunmeOperation,
  createSuggestionCommentAnchor,
  serializeOperationLog,
  type JsonValue,
  type NotebookLogHeader,
  type RunmeOperation,
} from '../../lib/operationLog'
import type LocalNotebooks from '../../storage/local'
import { OperationLogSuggestionView } from './OperationLogSuggestionView'

const notebookDataMocks = vi.hoisted(() => ({
  flushPendingPersist: vi.fn(async () => undefined),
  loadNotebook: vi.fn(),
  setNotebookStore: vi.fn(),
  getNotebookData: vi.fn(),
}))

vi.mock('../../lib/notebookDataController', () => ({
  getNotebookDataController: () => ({
    getNotebookData: notebookDataMocks.getNotebookData,
  }),
}))

const header: NotebookLogHeader = {
  record_type: 'runme.notebook',
  format_version: 1,
  notebook_id: 'notebook_test',
  created_by: 'actor_a',
  created_at: '2026-09-03T00:00:00Z',
}

function operation(
  known: RunmeOperation[],
  sequence: number,
  kind: string,
  payload: JsonValue,
  suggestionId: string
): RunmeOperation {
  return createRunmeOperation({
    actorId: 'actor_a',
    actorSequence: sequence,
    dependencies: known.length ? [known[known.length - 1].op_id] : [],
    knownOperations: known,
    kind,
    payload,
    suggestionId,
    createdAt: `2026-09-03T00:00:0${sequence}Z`,
  })
}

function operationLogDocument(): string {
  const operations: RunmeOperation[] = []
  operations.push(
    operation(
      operations,
      1,
      'cell.create',
      {
        cell_id: 'one',
        position: [[100, 'actor_a', 1]],
        cell: {
          kind: 'markup',
          language_id: 'markdown',
          value: 'Hello world',
          metadata: {},
        },
      },
      'suggestion:create'
    )
  )
  operations.push(
    operation(
      operations,
      2,
      'cell.update',
      {
        cell_id: 'one',
        cell: {
          kind: 'markup',
          language_id: 'markdown',
          value: 'Hello brave world',
          metadata: {},
        },
      },
      'suggestion:update'
    )
  )
  return serializeOperationLog(header, operations)
}

describe('OperationLogSuggestionView', () => {
  beforeEach(() => {
    notebookDataMocks.flushPendingPersist.mockClear()
    notebookDataMocks.loadNotebook.mockClear()
    notebookDataMocks.setNotebookStore.mockClear()
    notebookDataMocks.getNotebookData.mockReset()
    notebookDataMocks.getNotebookData.mockReturnValue({
      flushPendingPersist: notebookDataMocks.flushPendingPersist,
      loadNotebook: notebookDataMocks.loadNotebook,
      setNotebookStore: notebookDataMocks.setNotebookStore,
    })
  })

  it('keeps review controls and Drive-style discussion in the left panel', async () => {
    const addOperationLogComment = vi.fn().mockResolvedValue({})
    const replyToOperationLogComment = vi.fn().mockResolvedValue({})
    const rebasedSaveStore = { save: vi.fn() }
    const store = {
      loadContent: vi.fn().mockResolvedValue(operationLogDocument()),
      listOperationLogComments: vi.fn().mockResolvedValue([
        {
          id: 'comment-1',
          anchor: createSuggestionCommentAnchor('suggestion:update'),
          content: 'Please keep this wording.',
          createdTime: '2026-09-03T01:00:00Z',
          author: { displayName: 'Ada Reviewer' },
          replies: [
            {
              id: 'reply-1',
              content: 'Agreed.',
              createdTime: '2026-09-03T01:05:00Z',
              author: { displayName: 'Grace Author' },
            },
          ],
        },
      ]),
      addOperationLogComment,
      replyToOperationLogComment,
      reviewOperationLogSuggestion: vi.fn().mockResolvedValue(undefined),
      createOperationLogSaveStore: vi.fn().mockResolvedValue(rebasedSaveStore),
    } as unknown as LocalNotebooks

    render(
      <OperationLogSuggestionView
        docUri="local://file/test"
        store={store}
        readOnly={false}
        onClose={vi.fn()}
      />
    )

    expect(await screen.findByText('1 of 2')).toBeTruthy()
    expect(screen.getByTestId('suggestion-inserted-cell')).toBeTruthy()
    const reviewPanel = screen.getByRole('complementary', {
      name: 'Suggestion review',
    })
    const notebookCanvas = document.getElementById('suggestion-notebook-canvas')
    expect(reviewPanel.querySelector('#suggestion-navigation')).toBeTruthy()
    expect(reviewPanel.querySelector('#suggestion-comments')).toBeTruthy()
    expect(notebookCanvas?.querySelector('#suggestion-navigation')).toBeNull()
    expect(notebookCanvas?.querySelector('#suggestion-comments')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Next suggestion' }))
    expect(screen.getByText('2 of 2')).toBeTruthy()
    expect(screen.getByTestId('suggestion-modified-cell').textContent).toBe(
      'Hello brave world'
    )
    expect(screen.getByText('Ada Reviewer')).toBeTruthy()
    expect(screen.getByText('Please keep this wording.')).toBeTruthy()
    expect(screen.getByText('Grace Author')).toBeTruthy()
    expect(screen.getByText('Agreed.')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('New suggestion comment'), {
      target: { value: 'One more thought.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    await waitFor(() => expect(addOperationLogComment).toHaveBeenCalled())
    expect(addOperationLogComment).toHaveBeenCalledWith('local://file/test', {
      content: 'One more thought.',
      anchor: createSuggestionCommentAnchor('suggestion:update'),
      motivation: 'suggesting',
    })

    fireEvent.change(screen.getByLabelText('Reply to comment comment-1'), {
      target: { value: 'Looks good to me.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    await waitFor(() => expect(replyToOperationLogComment).toHaveBeenCalled())
    expect(replyToOperationLogComment).toHaveBeenCalledWith(
      'local://file/test',
      'comment-1',
      'Looks good to me.'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    await waitFor(() =>
      expect(store.reviewOperationLogSuggestion).toHaveBeenCalled()
    )
    expect(notebookDataMocks.flushPendingPersist).toHaveBeenCalled()
    expect(
      notebookDataMocks.flushPendingPersist.mock.invocationCallOrder[0]
    ).toBeLessThan(
      (store.reviewOperationLogSuggestion as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0]
    )
    expect(store.createOperationLogSaveStore).toHaveBeenCalledWith(
      'local://file/test'
    )
    expect(notebookDataMocks.setNotebookStore).toHaveBeenCalledWith(
      rebasedSaveStore
    )
    expect(notebookDataMocks.loadNotebook).toHaveBeenCalled()
    expect(
      notebookDataMocks.setNotebookStore.mock.invocationCallOrder[0]
    ).toBeLessThan(notebookDataMocks.loadNotebook.mock.invocationCallOrder[0])
  })
})
