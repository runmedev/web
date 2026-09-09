import { create } from '@bufbuild/protobuf'
import {
  act,
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
} from '../../lib/operationLog/legacyReviews'
import { parser_pb } from '../../runme/client'
import type { DriveComment } from '../../storage/drive'
import type LocalNotebooks from '../../storage/local'
import { NotebookReviewFlow } from './NotebookReviewFlow'
import { ReviewRevisionPicker } from './ReviewRevisionPicker'
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
  for (const v of versions) v.version = { kind: 'revision', revision_id: v.id }
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
    previewNotebookComparison: vi.fn(async (_uri, input) => ({
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
    loadContent: vi.fn(),
    listNotebookComparisons: vi.fn(async () => [...rounds]),
    listOperationLogComments: vi.fn(async () => [...comments]),
    checkpointNotebookRevision: vi.fn(),
    addAnchoredComment: vi.fn(async (_uri, input) => {
      if (!rounds.includes(second)) rounds.push(second)
      const a = input.anchors.find((a: any) => a.kind === 'cell')
      const c = {
        ...input,
        anchor: a
          ? JSON.stringify({
              runme: {
                version: 1,
                type: 'cell',
                cellId: a.cell_id,
                quote: 'Clarified',
              },
            })
          : undefined,
        id: 'new-thread',
        replies: [],
        author: {
          displayName: input.author.displayName,
          runmeAuthorKind: input.author.kind,
        },
      }
      second.threadIds.push(c.id)
      if (input.assessment) second.outcome = input.assessment.outcome
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
    decideNotebookComparisonCell: vi.fn(async (_uri, input) => {
      if (!rounds.includes(second)) rounds.push(second)
      const record = second
      ;(record.cellDecisions ??= []).push({
        cellId: input.cellId,
        decision: input.decision,
        operationId: 'decision',
        order: 1,
        author: input.author,
      })
    }),
  }
  return { store, first, second, rounds, comments, versions }
}

describe('comparison revision defaults', () => {
  it.each([
    { names: ['v1'], expected: 'v1' },
    { names: [], expected: 'empty' },
    { names: ['v2'], expected: 'v2' },
    { names: ['v1', 'v2', 'v3'], expected: 'v2' },
    { names: ['v3'], expected: 'empty' },
  ])(
    'starts at $expected with named revisions $names and ends at latest',
    async ({ names, expected }) => {
      const f = fixture()
      f.versions.push({
        id: 'v3',
        changeIds: ['head', 'edit', 'new'],
        operationIds: ['head', 'edit', 'new'],
      })
      for (const r of f.versions)
        r.name = names.includes(r.id) ? r.id : undefined
      render(
        <ReviewRevisionPicker
          revisions={f.versions}
          store={f.store as unknown as LocalNotebooks}
          docUri="local://file/test"
          disabled={false}
          onPreview={() => {}}
          onLabel={async () => true}
        />
      )
      expect(
        (screen.getByLabelText('Start revision') as HTMLSelectElement).value
      ).toBe(expected)
      expect(
        (screen.getByLabelText('End revision') as HTMLSelectElement).value
      ).toBe('v3')
      await waitFor(() =>
        expect(f.store.previewNotebookComparison).toHaveBeenCalledWith(
          'local://file/test',
          { startRevisionId: expected, endRevisionId: 'v3' }
        )
      )
    }
  )

  it('preserves explicit choices when new revisions or labels arrive', async () => {
    const f = fixture()
    const props = {
      store: f.store as unknown as LocalNotebooks,
      docUri: 'local://file/test',
      disabled: false,
      onPreview: vi.fn(),
      onLabel: async () => true,
    }
    const view = render(
      <ReviewRevisionPicker {...props} revisions={f.versions} />
    )
    fireEvent.change(screen.getByLabelText('Start revision'), {
      target: { value: 'empty' },
    })
    fireEvent.change(screen.getByLabelText('End revision'), {
      target: { value: 'v1' },
    })
    await waitFor(() =>
      expect(f.store.previewNotebookComparison).toHaveBeenLastCalledWith(
        'local://file/test',
        { startRevisionId: 'empty', endRevisionId: 'v1' }
      )
    )
    f.versions.push({
      id: 'v3',
      name: 'New label',
      changeIds: ['head', 'edit', 'new'],
      operationIds: ['head', 'edit', 'new'],
    })
    await act(async () => {
      view.rerender(
        <ReviewRevisionPicker {...props} revisions={[...f.versions]} />
      )
    })
    expect(
      (screen.getByLabelText('Start revision') as HTMLSelectElement).value
    ).toBe('empty')
    expect(
      (screen.getByLabelText('End revision') as HTMLSelectElement).value
    ).toBe('v1')
  })
})

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
  it('accepts a cell in the gutter, hides its diff and preserves its discussion', async () => {
    const f = fixture()
    mount(f)
    const accept = await screen.findByRole('button', {
      name: 'Accept changes to cell 1',
    })
    fireEvent.click(accept)
    await screen.findByText('Changes accepted')
    expect(f.store.decideNotebookComparisonCell).toHaveBeenCalledWith(
      'local://file/test',
      expect.objectContaining({ cellId: 'cell', decision: 'accept' })
    )
    expect(
      document.querySelector('[id^="suggestion-cell-unchanged-"]')
    ).not.toBeNull()
    expect(screen.getByText('Clarify the checks')).toBeTruthy()
    expect(f.store.setOperationLogCommentResolved).not.toHaveBeenCalled()
    expect(f.second.after.cells[0].value).toBe('Clarified')
    expect((accept as HTMLButtonElement).disabled).toBe(true)
  })
  it('opens a commentable diff without starting a review and shows ordinary editor comments', async () => {
    const f = fixture()
    f.comments[0].anchor = JSON.stringify({
      runme: { version: 2, type: 'cell', cellId: 'cell' },
    })
    mount(f)
    await screen.findByText('Clarify the checks')
    expect(screen.getByText('Clarified')).toBeTruthy()
    expect(screen.queryByText('Cell 1 · modified')).toBeNull()
    expect(screen.queryByLabelText('Review round')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start review' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Submit review' })).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Changes' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Change \d+$/ })).toBeNull()
    expect(f.store.checkpointNotebookRevision).not.toHaveBeenCalled()
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
    expect(f.store.addAnchoredComment).toHaveBeenCalledWith(
      'local://file/test',
      expect.objectContaining({
        anchors: [
          {
            kind: 'cell',
            cell_id: 'cell',
            surface: 'source',
            version: { kind: 'revision', revision_id: 'v2' },
          },
        ],
        comparison: {
          start: { kind: 'revision', revision_id: 'v1' },
          end: { kind: 'revision', revision_id: 'v2' },
        },
      })
    )
  })

  it('offers a direct change-card input and keeps drafts through hiding or failed sends', async () => {
    const f = fixture()
    mount(f)
    const input = await screen.findByRole('textbox', {
      name: 'Comment on changes to cell 1',
    })
    const form = screen.getByRole('form', {
      name: 'Comment on changes to cell 1',
    })
    expect(
      screen.queryByRole('button', { name: /^Comment on changes$/ })
    ).toBeNull()
    expect(document.activeElement).not.toBe(input)
    fireEvent.change(input, { target: { value: 'Please explain the change' } })
    fireEvent.click(screen.getByRole('button', { name: 'Hide comments' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show comments' }))
    expect((input as HTMLTextAreaElement).value).toBe(
      'Please explain the change'
    )
    f.store.addAnchoredComment.mockRejectedValueOnce(new Error('Save failed'))
    fireEvent.submit(form)
    await screen.findByText('Error: Save failed')
    expect((input as HTMLTextAreaElement).value).toBe(
      'Please explain the change'
    )
    fireEvent.submit(form)
    await screen.findByText('Please explain the change')
    expect((input as HTMLTextAreaElement).value).toBe('')
    const sent = f.store.addAnchoredComment.mock.calls.at(-1)![1]
    expect(sent.anchors[0]).toMatchObject({
      cell_id: 'cell',
      version: { kind: 'revision', revision_id: 'v2' },
    })
    expect(
      screen.queryByRole('textbox', { name: 'New cell comment' })
    ).toBeNull()
  })

  it('only marks cells with comment threads', async () => {
    const f = fixture()
    f.comments.length = 0
    mount(f)
    await screen.findByText('Clarified')
    expect(
      screen.queryByRole('button', { name: /comment threads for cell/ })
    ).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Hide comments' }))
    fireEvent.click(screen.getByRole('button', { name: 'Comment on cell' }))
    const gutter = screen.getByRole('complementary', {
      name: 'Comments for cell 1',
    })
    expect(within(gutter).getByLabelText('New cell comment')).toBeTruthy()
  })

  it('collapses the right gutter and reopens it from a marker without losing drafts', async () => {
    const f = fixture()
    mount(f)
    await screen.findByText('Clarified')
    fireEvent.click(screen.getByRole('button', { name: 'Comment on cell' }))
    fireEvent.change(screen.getByLabelText('New cell comment'), {
      target: { value: 'Cell draft' },
    })
    fireEvent.change(screen.getByLabelText('Reply to request'), {
      target: { value: 'Reply draft' },
    })
    const gutter = screen.getByRole('complementary', {
      name: 'Comments for cell 1',
    })
    gutter.scrollIntoView = vi.fn()
    fireEvent.click(screen.getByRole('button', { name: 'Hide comments' }))
    expect(
      screen.queryByRole('complementary', { name: 'Comments for cell 1' })
    ).toBeNull()
    expect(
      screen
        .getByRole('button', { name: 'Show comments' })
        .getAttribute('aria-expanded')
    ).toBe('false')
    expect(screen.getByText('Clarified')).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', { name: 'Show 1 comment threads for cell 1' })
    )
    expect(document.activeElement).toBe(gutter)
    expect(
      (screen.getByLabelText('New cell comment') as HTMLTextAreaElement).value
    ).toBe('Cell draft')
    expect(
      (screen.getByLabelText('Reply to request') as HTMLTextAreaElement).value
    ).toBe('Reply draft')
    fireEvent.click(screen.getByRole('button', { name: 'Hide comments' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show comments' }))
    expect(
      screen.getByRole('complementary', { name: 'Comments for cell 1' })
    ).toBe(gutter)
  })

  it('collapses controls without resetting revisions, scope, or comment drafts', async () => {
    const f = fixture()
    mount(f)
    await screen.findByText('Clarified')
    const start = screen.getByLabelText('Start revision') as HTMLSelectElement
    const end = screen.getByLabelText('End revision') as HTMLSelectElement
    const before = [start.value, end.value]
    fireEvent.change(screen.getByLabelText('New suggestion comment'), {
      target: { value: 'Keep this draft' },
    })
    const previews = f.store.previewNotebookComparison.mock.calls.length
    fireEvent.click(
      screen.getByRole('button', { name: 'Collapse comparison panel' })
    )
    const expand = screen.getByRole('button', {
      name: 'Expand comparison panel',
    })
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    expect(
      screen.queryByRole('combobox', { name: 'Start revision' })
    ).toBeNull()
    expect(screen.getByText('Clarified')).toBeTruthy()
    expect(screen.getByText('Clarify the checks')).toBeTruthy()
    fireEvent.click(expand)
    expect(
      screen
        .getByRole('button', { name: 'Collapse comparison panel' })
        .getAttribute('aria-expanded')
    ).toBe('true')
    expect([start.value, end.value]).toEqual(before)
    expect(
      (screen.getByLabelText('New suggestion comment') as HTMLTextAreaElement)
        .value
    ).toBe('Keep this draft')
    expect(
      (
        screen.getByRole('radio', {
          name: 'Whole document',
        }) as HTMLInputElement
      ).checked
    ).toBe(true)
    expect(f.store.previewNotebookComparison).toHaveBeenCalledTimes(previews)
    expect(f.store.checkpointNotebookRevision).not.toHaveBeenCalled()
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
    expect(f.store.previewNotebookComparison).toHaveBeenLastCalledWith(
      'local://file/test',
      expect.objectContaining({ cellIds: ['cell'] })
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Whole document' }))
    expect(await screen.findByText('Deploy discussion')).toBeTruthy()
    expect(f.store.checkpointNotebookRevision).not.toHaveBeenCalled()
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
    expect(
      within(document.getElementById('comparison-assessment')!).getByRole(
        'status'
      ).textContent
    ).toBe('Good Enough')
  })
  it('shares one suggestion conversation without a setup action', async () => {
    const f = fixture()
    f.rounds.push(f.second)
    f.second.threadIds.push('whole')
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
    expect(f.store.addAnchoredComment).not.toHaveBeenCalled()
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
    fireEvent.contextMenu(root)
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Comment on selection' })
    )
    fireEvent.change(screen.getByLabelText('New cell comment'), {
      target: { value: 'Explain old wording' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add cell comment' }))
    await screen.findByText('Explain old wording')
    expect(
      f.store.addAnchoredComment.mock.calls[0][1].anchors[0]
    ).toMatchObject({
      version: { kind: 'revision', revision_id: 'v1' },
      range: { start_index: 1, end_index: 4, unit: 'unicode-code-point' },
    })
    fireEvent.contextMenu(root)
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Comment on previous cell' })
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
    expect(f.store.checkpointNotebookRevision).not.toHaveBeenCalled()
  })
})
