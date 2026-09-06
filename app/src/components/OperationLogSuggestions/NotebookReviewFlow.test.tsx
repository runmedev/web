import { create } from '@bufbuild/protobuf'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { computeNotebookDiff } from '../../lib/notebookDiff/diff'
import { computeReviewDiff } from '../../lib/operationLog/reviewScope'
import {
  createReviewAnchor,
  type NotebookReviewRound,
} from '../../lib/operationLog/reviews'
import { parser_pb } from '../../runme/client'
import type { DriveComment } from '../../storage/drive'
import type LocalNotebooks from '../../storage/local'
import { NotebookReviewFlow } from './NotebookReviewFlow'
import type { NotebookRevision } from '../../lib/operationLog/revisions'

const flush = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../../lib/notebookDataController', () => ({
  getNotebookDataController: () => ({
    getNotebookData: () => ({ flushPendingPersist: flush }),
  }),
}))

function fixture() {
  const notebook = (value: string) =>
    create(parser_pb.NotebookSchema, {
      cells: value
        ? [
            create(parser_pb.CellSchema, {
              refId: 'cell',
              kind: parser_pb.CellKind.MARKUP,
              value,
              languageId: 'markdown',
            }),
          ]
        : [],
    })
  const round = (
    id: string,
    before: string,
    after: string
  ): NotebookReviewRound => ({
    id,
    title: id,
    author: { displayName: 'unknown', kind: 'unknown' },
    createdAt: '2026-09-05T00:00:00Z',
    baseOperationIds: before ? ['base'] : [],
    headOperationIds: ['head'],
    threadIds: [],
    before: notebook(before),
    after: notebook(after),
    diff: computeNotebookDiff(notebook(before), notebook(after), {
      includeMetadata: true,
      includeOutputs: true,
    }),
  })
  const first = round('Round 1', '', 'Original')
  const second = round('Round 2', 'Original', 'Clarified')
  const rounds = [first]
  const versions: NotebookRevision[] = [
    { id: 'empty', operationIds: [], changeIds: [] },
    {
      id: 'v1',
      operationIds: ['head'],
      changeIds: ['head'],
      name: 'Initial',
      lastChangedAt: '2026-09-05T23:00:00Z',
    },
    {
      id: 'v2',
      operationIds: ['head', 'edit'],
      changeIds: ['edit', 'head'],
      name: 'Addressed',
      description: 'Codex addressed comments',
      lastChangedAt: '2026-09-05T23:13:00Z',
    },
  ]
  const comments: DriveComment[] = [
    {
      id: 'request',
      anchor: createReviewAnchor(first.id, 'cell', 'Original'),
      content: 'Clarify the checks',
      author: {
        displayName: 'Ada',
        runmeAuthorKind: 'human',
        runmeAuthorSource: 'google-drive',
        runmeAuthenticatedPrincipal: 'ada',
      },
      replies: [
        {
          id: 'agent-reply',
          content: 'Added checks',
          author: { displayName: 'Codex', runmeAuthorKind: 'agent' },
        },
      ],
    },
  ]
  const store = {
    listNotebookRevisions: vi.fn(async () => versions),
    labelNotebookRevision: vi.fn(async () => undefined),
    previewNotebookReview: vi.fn(async (_uri, input) => ({
      start: versions.find((r) => r.id === input.startRevisionId)!,
      end: versions.find((r) => r.id === input.endRevisionId)!,
      before: input.startRevisionId === 'empty' ? first.before : second.before,
      after: input.endRevisionId === 'v1' ? first.after : second.after,
      cellIds: input.cellIds,
      diff: computeReviewDiff(
        input.startRevisionId === 'empty' ? first.before : second.before,
        input.endRevisionId === 'v1' ? first.after : second.after,
        input.cellIds
      ),
      existingReviewId:
        input.endRevisionId === 'v1' && !input.cellIds ? 'Round 1' : undefined,
    })),
    listNotebookReviews: vi.fn(async () => [...rounds]),
    listOperationLogComments: vi.fn(async () => [...comments]),
    createNotebookReview: vi.fn(async () => {
      rounds.push(second)
      return second
    }),
    linkNotebookReviewThread: vi.fn(async (_uri, _round, id) => {
      second.threadIds.push(id)
    }),
    addOperationLogComment: vi.fn(async (_uri, input) => {
      const c = {
        ...input,
        id: 'new-thread',
        replies: [],
        author: {
          displayName: input.author.displayName,
          runmeAuthorKind: input.author.kind,
        },
      }
      comments.push(c)
      return c
    }),
    replyToOperationLogComment: vi.fn(async (_uri, id, content) => {
      comments
        .find((c) => c.id === id)!
        .replies!.push({ id: 'human-reply', content })
      return comments[0]
    }),
    setOperationLogCommentResolved: vi.fn(async (_uri, id, resolved) => {
      comments.find((c) => c.id === id)!.resolved = resolved
      return comments[0]
    }),
    submitNotebookReview: vi.fn(async (_uri, input) => {
      Object.assign(rounds.find((r) => r.id === input.reviewId)!, {
        outcome: input.outcome,
        summary: input.summary,
      })
    }),
  }
  return { store, first, second, rounds, comments }
}

describe('notebook review flow', () => {
  it('previews a heading range, distinguishes whole-document reviews, and starts the fixed scope', async () => {
    const f = fixture()
    f.first.after.cells = [
      ['intro', '# Guide'],
      ['setup', '## Setup'],
      ['body', 'Install this'],
      ['linux', '### Linux'],
      ['commands', 'Linux commands'],
      ['deploy', '## Deploy'],
    ].map(([refId, value]) =>
      create(parser_pb.CellSchema, {
        refId,
        value,
        languageId: 'markdown',
        kind: parser_pb.CellKind.MARKUP,
      })
    )
    render(
      <NotebookReviewFlow
        docUri="local://file/test"
        store={f.store as unknown as LocalNotebooks}
        readOnly={false}
        onClose={() => {}}
      />
    )
    await screen.findByText('Clarify the checks')
    expect(screen.getByRole('option', { name: 'Good Enough' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Needs More Work' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Review round'), {
      target: { value: 'new' },
    })
    fireEvent.change(screen.getByLabelText('End revision'), {
      target: { value: 'v1' },
    })
    await screen.findByRole('button', { name: 'Continue review' })
    fireEvent.click(
      screen.getByRole('radio', { name: 'Heading / section range' })
    )
    fireEvent.change(screen.getByLabelText('From heading'), {
      target: { value: 'setup:1' },
    })
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: 'Start review',
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    )
    const canvas = within(document.getElementById('review-round-canvas')!)
    expect(canvas.queryByText('# Guide')).toBeNull()
    expect(canvas.queryByText('## Deploy')).toBeNull()
    expect(canvas.getByText('### Linux')).toBeTruthy()
    expect(
      [
        ...(screen.getByLabelText('Through section') as HTMLSelectElement)
          .options,
      ].map((o) => o.value)
    ).toEqual(['setup:1', 'linux:1', 'deploy:1'])
    // Start is a separate creation from the existing whole-document pair.
    fireEvent.click(screen.getByRole('button', { name: 'Start review' }))
    await waitFor(() =>
      expect(f.store.createNotebookReview).toHaveBeenCalledWith(
        'local://file/test',
        expect.objectContaining({
          startRevisionId: 'empty',
          endRevisionId: 'v1',
          cellIds: ['setup', 'body', 'linux', 'commands'],
        })
      )
    )
  })
  it('previews revision choices under the new-review option and continues an existing pair', async () => {
    const f = fixture()
    render(
      <NotebookReviewFlow
        docUri="local://file/test"
        store={f.store as unknown as LocalNotebooks}
        readOnly={false}
        onClose={() => {}}
      />
    )
    await screen.findByText('Clarify the checks')
    expect(
      screen.queryByRole('button', { name: 'Start new review' })
    ).toBeNull()
    expect(screen.queryByLabelText('Start revision')).toBeNull()
    fireEvent.change(screen.getByLabelText('Review round'), {
      target: { value: 'new' },
    })
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: 'Start review',
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    )
    expect(screen.queryByRole('button', { name: 'Submit review' })).toBeNull()
    expect(screen.queryByLabelText('Review discussion')).toBeNull()
    expect(screen.getByText('Clarified')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Start revision'), {
      target: { value: 'v1' },
    })
    const end = screen.getByLabelText('End revision') as HTMLSelectElement
    expect([...end.options].map((o) => o.value)).toEqual(['v2'])
    fireEvent.change(screen.getByLabelText('Start revision'), {
      target: { value: 'empty' },
    })
    fireEvent.change(end, { target: { value: 'v1' } })
    await screen.findByRole('button', { name: 'Continue review' })
    expect(screen.getByText('Original')).toBeTruthy()
    // Native selects may emit change when an existing option is reselected.
    fireEvent.change(end, { target: { value: 'v1' } })
    expect(screen.getByRole('button', { name: 'Continue review' })).toBeTruthy()
    expect(screen.getByText('Original')).toBeTruthy()
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Named revisions only' })
    )
    await screen.findByRole('button', { name: 'Continue review' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue review' }))
    await screen.findByText('Clarify the checks')
    expect(f.store.createNotebookReview).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Start revision')).toBeNull()
  })
  it('keeps a single review-wide conversation in the panel and cell threads in the diff', async () => {
    const f = fixture()
    f.comments.push(
      {
        id: 'whole',
        anchor: createReviewAnchor(f.first.id),
        content: 'Review-wide question',
        replies: [],
      },
      {
        id: 'whole-legacy',
        anchor: createReviewAnchor(f.first.id),
        content: 'Another older root',
        replies: [],
      }
    )
    render(
      <NotebookReviewFlow
        docUri="local://file/test"
        store={f.store as unknown as LocalNotebooks}
        readOnly={false}
        onClose={() => {}}
      />
    )
    await screen.findByText('Review-wide question')
    const panel = within(screen.getByLabelText('Notebook review'))
    expect(panel.queryByText('Clarify the checks')).toBeNull()
    expect(panel.getAllByLabelText('Review discussion')).toHaveLength(1)
    expect(panel.getByText('Another older root')).toBeTruthy()
    expect(panel.queryByLabelText('Discussion target')).toBeNull()
    expect(
      within(document.getElementById('review-round-canvas')!).getByText(
        'Clarify the checks'
      )
    ).toBeTruthy()
    fireEvent.change(panel.getByLabelText('New review comment'), {
      target: { value: 'A review-wide reply' },
    })
    fireEvent.click(panel.getByRole('button', { name: 'Send review comment' }))
    await screen.findByText('A review-wide reply')
    expect(f.store.addOperationLogComment).not.toHaveBeenCalled()
    expect(f.store.replyToOperationLogComment).toHaveBeenCalledWith(
      'local://file/test',
      'whole',
      'A review-wide reply',
      expect.anything()
    )
  })
  it('opens the composer from a diff selection, persists its frozen range, and resets on round changes', async () => {
    const f = fixture()
    f.rounds.push(f.second)
    render(
      <NotebookReviewFlow
        docUri="local://file/test"
        store={f.store as unknown as LocalNotebooks}
        readOnly={false}
        onClose={() => {}}
      />
    )
    await screen.findByText('Clarified')
    const root = screen.getByLabelText('Selectable cell diff')
    const removed = [...root.querySelectorAll('[data-diff-run]')].find(
      (s) => s.textContent === 'Original'
    )!
    const range = document.createRange()
    range.setStart(removed.firstChild!, 1)
    range.setEnd(removed.firstChild!, 4)
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)
    fireEvent.mouseUp(root)
    fireEvent.click(
      screen.getByRole('button', { name: 'Comment on selection' })
    )
    const composer = screen.getByLabelText('New cell comment')
    expect(document.activeElement).toBe(composer)
    fireEvent.change(composer, {
      target: { value: 'Explain this old wording' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add cell comment' }))
    await screen.findByText('Explain this old wording')
    const input = f.store.addOperationLogComment.mock.calls[0][1]
    expect(JSON.parse(input.anchor).runme).toMatchObject({
      reviewId: 'Round 2',
      diffTarget: {
        cellId: 'cell',
        side: 'base',
        quote: 'rig',
        sourceRange: { start: 1, end: 4, unit: 'utf-16' },
      },
    })
    expect(screen.queryByText(/Outdated context/)).toBeNull()
    fireEvent.click(
      screen.getByRole('button', { name: 'Comment on previous cell' })
    )
    fireEvent.change(screen.getByLabelText('Review round'), {
      target: { value: 'Round 1' },
    })
    expect(screen.queryByText('Previous cell: Original')).toBeNull()
    expect(screen.queryByLabelText('Discussion target')).toBeNull()
    expect(screen.queryByLabelText('New cell comment')).toBeNull()
    document.getSelection()!.removeAllRanges()
  })
  it('carries a discussion through two rounds, replies, resolves explicitly, and submits feedback', async () => {
    const f = fixture()
    render(
      <NotebookReviewFlow
        docUri="local://file/test"
        store={f.store as unknown as LocalNotebooks}
        readOnly={false}
        onClose={() => {}}
      />
    )
    await screen.findByText('Clarify the checks')
    expect(screen.getByText('Ada · human · Google Drive identity')).toBeTruthy()
    expect(
      screen.getByText('Codex · agent · supplied attribution')
    ).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Review round'), {
      target: { value: 'new' },
    })
    fireEvent.change(screen.getByLabelText('Start revision'), {
      target: { value: 'v1' },
    })
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: 'Start review',
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Start review' }))
    await waitFor(() =>
      expect(f.store.linkNotebookReviewThread).toHaveBeenCalledWith(
        'local://file/test',
        'Round 2',
        'request'
      )
    )
    expect(flush).toHaveBeenCalled()
    expect(f.store.createNotebookReview).toHaveBeenCalledWith(
      'local://file/test',
      expect.objectContaining({ startRevisionId: 'v1', endRevisionId: 'v2' })
    )
    await screen.findByText(/Outdated context/)
    fireEvent.change(screen.getByLabelText('Reply to request'), {
      target: { value: 'These checks are clear now' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    await screen.findByText('These checks are clear now')
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }))
    await waitFor(() => expect(f.comments[0].resolved).toBe(true))
    fireEvent.change(screen.getByLabelText('New review comment'), {
      target: { value: 'Who owns the rollout?' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send review comment' }))
    await screen.findByText('Who owns the rollout?')
    fireEvent.change(screen.getByLabelText('Review outcome'), {
      target: { value: 'good_enough' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit review' }))
    await waitFor(() => expect(f.second.outcome).toBe('good_enough'))
    expect(f.store.setOperationLogCommentResolved).toHaveBeenCalledTimes(1)
    expect(f.comments[1].resolved).not.toBe(true)
    fireEvent.change(screen.getByLabelText('Review round'), {
      target: { value: 'Round 1' },
    })
    expect(f.first.after.cells[0].value).toBe('Original')
    expect(screen.getByText('These checks are clear now')).toBeTruthy()
    expect(screen.queryByText('Who owns the rollout?')).toBeNull()
  })

  it('disables mutations when the source editor is unavailable or read-only', async () => {
    const f = fixture()
    render(
      <NotebookReviewFlow
        docUri="local://file/test"
        store={f.store as unknown as LocalNotebooks}
        readOnly
        onClose={() => {}}
      />
    )
    await screen.findByText('Clarify the checks')
    for (const name of [
      'Resolve',
      'Send review comment',
      'Submit review',
      'Comment on cell',
    ]) {
      expect(
        (screen.getByRole('button', { name }) as HTMLButtonElement).disabled
      ).toBe(true)
    }
    expect(f.store.createNotebookReview).not.toHaveBeenCalled()
  })
})
