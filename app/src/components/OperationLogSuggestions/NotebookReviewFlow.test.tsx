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
  second.baseOperationIds = ['head']
  second.headOperationIds = ['head', 'edit']
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

describe('comment-first comparison flow', () => {
  const mount = (f: ReturnType<typeof fixture>, readOnly = false) =>
    render(
      <NotebookReviewFlow
        docUri="local://file/test"
        store={f.store as unknown as LocalNotebooks}
        readOnly={readOnly}
        onClose={() => {}}
      />
    )
  it('opens a commentable diff without starting a review and shows ordinary editor comments', async () => {
    const f = fixture()
    f.comments[0].anchor = JSON.stringify({
      runme: { version: 2, type: 'cell', cellId: 'cell' },
    })
    mount(f)
    await screen.findByText('Clarify the checks')
    expect(screen.getByText('Clarified')).toBeTruthy()
    expect(screen.queryByLabelText('Review round')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start review' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Submit review' })).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Changes' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Change \d+$/ })).toBeNull()
    expect(f.store.createNotebookReview).not.toHaveBeenCalled()
    const gutter = screen.getByRole('complementary', {
      name: 'Comments for cell 1',
    })
    expect(within(gutter).getByText('Clarify the checks')).toBeTruthy()
    expect(within(gutter).queryByText('Clarified')).toBeNull()
    const marker = screen.getByRole('button', {
      name: 'Show 1 comment threads for cell 1',
    })
    expect(marker.getAttribute('aria-controls')).toBe(gutter.id)
    gutter.scrollIntoView = vi.fn()
    fireEvent.click(marker)
    expect(document.activeElement).toBe(gutter)
    fireEvent.click(screen.getByRole('button', { name: 'Comment on cell' }))
    expect(within(gutter).getByLabelText('New cell comment')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('New cell comment'), {
      target: { value: 'Explain this change' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add cell comment' }))
    await screen.findByText('Explain this change')
    expect(f.store.createNotebookReview).toHaveBeenCalledWith(
      'local://file/test',
      expect.objectContaining({ startRevisionId: 'v1', endRevisionId: 'v2' })
    )
    expect(
      JSON.parse(f.store.addOperationLogComment.mock.calls[0][1].anchor).runme
        .diffTarget
    ).toMatchObject({ cellId: 'cell', side: 'head', quote: 'Clarified' })
  })

  it('only marks cells with comment threads', async () => {
    const f = fixture()
    f.comments.length = 0
    mount(f)
    await screen.findByText('Clarified')
    expect(
      screen.queryByRole('button', { name: /comment threads for cell/ })
    ).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Comment on cell' }))
    const gutter = screen.getByRole('complementary', {
      name: 'Comments for cell 1',
    })
    expect(within(gutter).getByLabelText('New cell comment')).toBeTruthy()
  })

  it('filters editor threads to the selected section while retaining unchanged context', async () => {
    const f = fixture()
    f.second.before.cells[0].value = '## Setup\nOriginal'
    f.second.after.cells[0].value = '## Setup\nClarified'
    for (const nb of [f.second.before, f.second.after]) {
      nb.cells.push(
        create(parser_pb.CellSchema, {
          refId: 'deploy',
          kind: parser_pb.CellKind.MARKUP,
          languageId: 'markdown',
          value: '## Deploy\nDeploy context',
        })
      )
    }
    f.comments.push({
      id: 'outside',
      content: 'Deploy discussion',
      anchor: JSON.stringify({
        runme: { type: 'cell', version: 2, cellId: 'deploy' },
      }),
    })
    mount(f)
    await screen.findByText('Deploy discussion')
    fireEvent.click(
      screen.getByRole('radio', { name: 'Heading / section range' })
    )
    await waitFor(() =>
      expect(screen.queryByText('Deploy discussion')).toBeNull()
    )
    expect(screen.getByText('Clarify the checks')).toBeTruthy()
    expect(f.store.previewNotebookReview).toHaveBeenLastCalledWith(
      'local://file/test',
      expect.objectContaining({ cellIds: ['cell'] })
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Whole document' }))
    expect(await screen.findByText('Deploy discussion')).toBeTruthy()
    expect(f.store.createNotebookReview).not.toHaveBeenCalled()
  })
  it('replies to the same thread and assesses without resolving or editing cells', async () => {
    const f = fixture()
    mount(f)
    await screen.findByText('Clarify the checks')
    fireEvent.change(screen.getByLabelText('Reply to request'), {
      target: { value: 'These checks are clear' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    await screen.findByText('These checks are clear')
    expect(f.store.replyToOperationLogComment).toHaveBeenCalledWith(
      'local://file/test',
      'request',
      'These checks are clear',
      expect.anything()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Good Enough' }))
    await waitFor(() => expect(f.second.outcome).toBe('good_enough'))
    expect(f.store.setOperationLogCommentResolved).not.toHaveBeenCalled()
    expect(f.second.after.cells[0].value).toBe('Clarified')
    expect(screen.getByRole('status').textContent).toBe('Good Enough')
  })
  it('shares one suggestion conversation without a setup action', async () => {
    const f = fixture()
    f.rounds.push(f.second)
    f.comments.push({
      id: 'whole',
      anchor: createReviewAnchor(f.second.id),
      content: 'Suggestion-wide question',
      replies: [],
    })
    mount(f)
    await screen.findByText('Suggestion-wide question')
    const panel = within(screen.getByLabelText('Notebook comparison'))
    expect(panel.queryByText('Clarify the checks')).toBeNull()
    fireEvent.change(screen.getByLabelText('New suggestion comment'), {
      target: { value: 'Same topic' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send comment' }))
    await screen.findByText('Same topic')
    expect(f.store.addOperationLogComment).not.toHaveBeenCalled()
    expect(f.store.replyToOperationLogComment).toHaveBeenCalledWith(
      'local://file/test',
      'whole',
      'Same topic',
      expect.anything()
    )
  })
  it('keeps frozen text selection and cancels a composer when endpoints change', async () => {
    const f = fixture()
    mount(f)
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
    fireEvent.change(screen.getByLabelText('New cell comment'), {
      target: { value: 'Explain old wording' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add cell comment' }))
    await screen.findByText('Explain old wording')
    expect(
      JSON.parse(f.store.addOperationLogComment.mock.calls[0][1].anchor).runme
        .diffTarget
    ).toMatchObject({
      side: 'base',
      quote: 'rig',
      sourceRange: { start: 1, end: 4, unit: 'utf-16' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Comment on previous cell' })
    )
    fireEvent.change(screen.getByLabelText('Start revision'), {
      target: { value: 'empty' },
    })
    await waitFor(() =>
      expect(screen.queryByLabelText('New cell comment')).toBeNull()
    )
    document.getSelection()!.removeAllRanges()
  })
  it('allows read-only navigation but disables mutations', async () => {
    const f = fixture()
    mount(f, true)
    await screen.findByText('Clarified')
    expect(
      (screen.getByLabelText('Start revision') as HTMLSelectElement).disabled
    ).toBe(false)
    for (const name of [
      'Resolve',
      'Good Enough',
      'Needs More Work',
      'Send comment',
      'Comment on cell',
    ])
      expect(
        (screen.getByRole('button', { name }) as HTMLButtonElement).disabled
      ).toBe(true)
    expect(f.store.createNotebookReview).not.toHaveBeenCalled()
  })
})
