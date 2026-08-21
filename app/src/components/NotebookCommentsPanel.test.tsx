// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type {
  CellCommentThread,
  CommentDraftTarget,
} from '../lib/notebookComments'
import { createCellCommentAnchor } from '../lib/notebookComments'
import { NotebookCommentsPanel } from './NotebookCommentsPanel'

const noopAsync = vi.fn(async () => undefined)
const noop = vi.fn()

function renderPanel(overrides = {}) {
  const props = {
    status: 'available' as const,
    threads: [],
    cellLabels: new Map<string, string>(),
    activeCellId: null,
    draftTarget: null,
    draftContent: '',
    busy: false,
    pendingCount: 0,
    failedCount: 0,
    onCancelDraft: noop,
    onDraftContentChange: noop,
    onCreateComment: noopAsync,
    onReply: noopAsync,
    onResolve: noopAsync,
    onReopen: noopAsync,
    onRefresh: noop,
    onRetryFailed: noop,
    onHide: noop,
    onSelectTarget: noop,
    ...overrides,
  }

  const view = render(<NotebookCommentsPanel {...props} />)

  return { ...props, ...view }
}

describe('NotebookCommentsPanel', () => {
  it('calls onHide from the header hide button', () => {
    const onHide = vi.fn()

    renderPanel({ onHide })

    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))

    expect(onHide).toHaveBeenCalledTimes(1)
  })

  it('shows locally saved operations without replacing the comments view', () => {
    renderPanel({
      pendingCount: 1,
      threads: [
        thread('Waiting to sync', 'cell-1', {
          id: 'local:operation-1',
          runmeSyncStatus: 'pending',
        }),
      ],
      cellLabels: new Map([['cell-1', 'Cell 1']]),
    })

    expect(screen.getByText(/saved locally and waiting to sync/i)).toBeTruthy()
    expect(screen.getByText('Waiting to sync')).toBeTruthy()
    expect(screen.getByText('Saved locally')).toBeTruthy()
  })

  it('offers an explicit retry for failed operations', () => {
    const onRetryFailed = vi.fn()
    renderPanel({ failedCount: 1, onRetryFailed })

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(onRetryFailed).toHaveBeenCalledTimes(1)
  })

  it('orders anchored threads by cell order instead of modification time', () => {
    const threads: CellCommentThread[] = [
      thread('comment on cell two', 'cell-2', {
        id: 'comment-2',
        createdTime: '2026-06-14T10:00:00Z',
        modifiedTime: '2026-06-14T10:00:00Z',
      }),
      thread('comment on cell one', 'cell-1', {
        id: 'comment-1',
        createdTime: '2026-06-14T11:00:00Z',
        modifiedTime: '2026-06-14T12:00:00Z',
      }),
    ]

    renderPanel({
      threads,
      cellLabels: new Map([
        ['cell-1', 'Cell 1'],
        ['cell-2', 'Cell 2'],
      ]),
    })

    const text = document.body.textContent ?? ''
    expect(text.indexOf('comment on cell one')).toBeLessThan(
      text.indexOf('comment on cell two')
    )
  })

  it('orders a draft comment by the target cell instead of pinning it first', () => {
    renderPanel({
      threads: [
        thread('comment on cell three', 'cell-3', { id: 'comment-3' }),
        thread('comment on cell one', 'cell-1', { id: 'comment-1' }),
      ],
      draftTarget: { type: 'cell' as const, cellId: 'cell-2' },
      cellLabels: new Map([
        ['cell-1', 'Cell 1'],
        ['cell-2', 'Cell 2'],
        ['cell-3', 'Cell 3'],
      ]),
    })

    const text = document.body.textContent ?? ''
    expect(text.indexOf('comment on cell one')).toBeLessThan(
      text.indexOf('New comment on Cell 2')
    )
    expect(text.indexOf('New comment on Cell 2')).toBeLessThan(
      text.indexOf('comment on cell three')
    )
  })

  it('marks the draft comment active when its cell has focus', () => {
    renderPanel({
      draftTarget: { type: 'cell' as const, cellId: 'cell-2' },
      activeCellId: 'cell-2',
      cellLabels: new Map([['cell-2', 'Cell 2']]),
    })

    const draft = screen.getByText('New comment on Cell 2').closest('article')

    expect(draft).not.toBeNull()
    expect(draft?.getAttribute('aria-current')).toBe('true')
  })

  it('groups multiple top-level comments on the same cell into one thread card', () => {
    renderPanel({
      threads: [
        thread('first comment on cell four', 'cell-4', { id: 'comment-1' }),
        thread('second comment on cell four', 'cell-4', { id: 'comment-2' }),
      ],
      draftTarget: { type: 'cell' as const, cellId: 'cell-4' },
      activeCellId: 'cell-4',
      cellLabels: new Map([['cell-4', 'Cell 4']]),
    })

    const articles = document.querySelectorAll(
      '[data-comment-panel-item="thread"]'
    )
    const article = articles[0] as HTMLElement

    expect(articles).toHaveLength(1)
    expect(within(article).getByText('first comment on cell four')).toBeTruthy()
    expect(
      within(article).getByText('second comment on cell four')
    ).toBeTruthy()
    expect(within(article).getByText('New comment on Cell 4')).toBeTruthy()
    expect(article.querySelectorAll('[data-comment-message]')).toHaveLength(2)
  })

  it('only shows reply and resolve controls on the active thread', () => {
    const threads: CellCommentThread[] = [
      thread('inactive thread', 'cell-1', { id: 'comment-1' }),
      thread('active thread', 'cell-2', { id: 'comment-2' }),
    ]

    renderPanel({
      threads,
      activeCellId: 'cell-2',
      cellLabels: new Map([
        ['cell-1', 'Cell 1'],
        ['cell-2', 'Cell 2'],
      ]),
    })

    const inactiveArticle = screen
      .getByText('inactive thread')
      .closest('article')
    const activeArticle = screen.getByText('active thread').closest('article')

    expect(inactiveArticle).not.toBeNull()
    expect(activeArticle).not.toBeNull()
    expect(
      within(inactiveArticle as HTMLElement).queryByRole('button', {
        name: 'Resolve',
      })
    ).toBeNull()
    expect(
      within(inactiveArticle as HTMLElement).queryByRole('button', {
        name: 'Reply',
      })
    ).toBeNull()
    expect(
      within(activeArticle as HTMLElement).getByRole('button', {
        name: 'Resolve',
      })
    ).toBeTruthy()
    expect(
      within(activeArticle as HTMLElement).getByRole('button', {
        name: 'Reply',
      })
    ).toBeTruthy()
    expect(
      within(activeArticle as HTMLElement).getByText('Active')
    ).toBeTruthy()
  })

  it('moves the active thread when the focused cell changes', async () => {
    const threads: CellCommentThread[] = [
      thread('first thread', 'cell-1', { id: 'comment-1' }),
      thread('second thread', 'cell-2', { id: 'comment-2' }),
    ]
    const cellLabels = new Map([
      ['cell-1', 'Cell 1'],
      ['cell-2', 'Cell 2'],
    ])

    const view = renderPanel({
      threads,
      cellLabels,
      activeCellId: 'cell-1',
    })

    view.rerender(
      <NotebookCommentsPanel
        {...view}
        threads={threads}
        cellLabels={cellLabels}
        activeCellId="cell-2"
      />
    )

    await waitFor(() => {
      const firstArticle = screen.getByText('first thread').closest('article')
      const secondArticle = screen.getByText('second thread').closest('article')

      expect(firstArticle).not.toBeNull()
      expect(secondArticle).not.toBeNull()
      expect(
        within(firstArticle as HTMLElement).queryByRole('button', {
          name: 'Reply',
        })
      ).toBeNull()
      expect(
        within(secondArticle as HTMLElement).getByRole('button', {
          name: 'Reply',
        })
      ).toBeTruthy()
    })
  })

  it('selects the owning cell when a comment thread is clicked', () => {
    const onSelectTarget = vi.fn()

    renderPanel({
      threads: [thread('cell one thread', 'cell-1', { id: 'comment-1' })],
      cellLabels: new Map([['cell-1', 'Cell 1']]),
      onSelectTarget,
    })

    fireEvent.click(screen.getByText('cell one thread').closest('article')!)

    expect(onSelectTarget).toHaveBeenCalledWith({ cellId: 'cell-1' })
  })

  it('does not treat textarea space key presses as thread selection', () => {
    const onSelectTarget = vi.fn()
    const threads: CellCommentThread[] = [
      thread('active thread', 'cell-1', { id: 'comment-1' }),
    ]

    renderPanel({
      threads,
      activeCellId: 'cell-1',
      cellLabels: new Map([['cell-1', 'Cell 1']]),
      onSelectTarget,
    })

    const textarea = screen.getByPlaceholderText('Reply or add others with @')
    fireEvent.keyDown(textarea, { key: ' ' })

    expect(onSelectTarget).not.toHaveBeenCalled()
  })

  it('shows missing comment targets as deleted cells without selecting them', () => {
    const onSelectTarget = vi.fn()
    const orphaned = thread('orphaned comment', 'markup_intro', {
      id: 'comment-orphaned',
    })
    orphaned.orphaned = true

    renderPanel({ threads: [orphaned], onSelectTarget })

    expect(screen.getByText('Deleted cell')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cell' })).toBeNull()
    fireEvent.click(screen.getByText('orphaned comment').closest('article')!)
    expect(onSelectTarget).not.toHaveBeenCalled()
  })

  it('shows a rendered selection draft as its own quoted thread', () => {
    renderPanel({
      threads: [thread('whole cell comment', 'cell-1', { id: 'whole-cell' })],
      draftTarget: rangeDraftTarget(),
      activeCellId: 'cell-1',
      cellLabels: new Map([['cell-1', 'Cell 1']]),
    })

    expect(screen.getByText('the migration guide')).toBeTruthy()
    expect(
      document.querySelectorAll('[data-comment-panel-item="thread"]')
    ).toHaveLength(2)
  })

  it('keeps a comment draft when creation fails', async () => {
    const onCreateComment = vi.fn(async () => {
      throw new Error('credential expired')
    })
    renderPanel({
      draftTarget: rangeDraftTarget(),
      cellLabels: new Map([['cell-1', 'Cell 1']]),
      onCreateComment,
    })

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'Please clarify this.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))

    await waitFor(() => expect(onCreateComment).toHaveBeenCalledOnce())
    expect(textarea.value).toBe('Please clarify this.')
  })

  it('keeps only the selected range thread active within one cell', async () => {
    const onSelectTarget = vi.fn()
    renderPanel({
      threads: [
        rangeThread('first range', 'comment-range-1', 5, 8),
        rangeThread('second range', 'comment-range-2', 12, 18),
      ],
      activeCellId: 'cell-1',
      cellLabels: new Map([['cell-1', 'Cell 1']]),
      onSelectTarget,
    })

    const first = screen.getByText('first range').closest('article')!
    const second = screen.getByText('second range').closest('article')!
    fireEvent.click(second)

    expect(onSelectTarget).toHaveBeenCalledWith({
      cellId: 'cell-1',
      range: { start: 12, end: 18 },
    })

    await waitFor(() => {
      expect(first.getAttribute('aria-current')).toBeNull()
      expect(second.getAttribute('aria-current')).toBe('true')
    })
  })
})

function rangeDraftTarget(): CommentDraftTarget {
  return {
    type: 'cell-text',
    cellId: 'cell-1',
    surface: 'rendered-markdown',
    source: 'Read **the migration guide**.',
    projection: {
      name: 'runme-markdown-text',
      version: 1,
      text: 'Read the migration guide.',
      segments: [],
    },
    selectors: [
      { type: 'TextPositionSelector', start: 5, end: 24 },
      { type: 'TextQuoteSelector', exact: 'the migration guide' },
    ],
    sourceHints: [{ start: 7, end: 26 }],
  }
}

function rangeThread(
  content: string,
  id: string,
  start: number,
  end: number
): CellCommentThread {
  return {
    cellId: 'cell-1',
    orphaned: false,
    anchor: {
      type: 'cell-text',
      cellId: 'cell-1',
      version: 2,
      surface: 'rendered-markdown',
      state: {
        driveRevisionId: 'revision-1',
        sourceSha256: 'source-hash',
        projection: {
          name: 'runme-markdown-text',
          version: 1,
          sha256: 'projection-hash',
        },
      },
      selectors: [
        { type: 'TextPositionSelector', start, end },
        {
          type: 'TextQuoteSelector',
          exact: `range ${start}-${end}`,
        },
      ],
    },
    location: { status: 'exact', start, end },
    comment: {
      id,
      content,
      createdTime: '2026-06-14T10:00:00Z',
      modifiedTime: '2026-06-14T10:00:00Z',
      author: { displayName: 'Tester' },
      resolved: false,
      replies: [],
    },
  }
}

function thread(
  content: string,
  cellId: string,
  overrides: Partial<CellCommentThread['comment']> = {}
): CellCommentThread {
  return {
    cellId,
    orphaned: false,
    anchor: {
      type: 'cell',
      cellId,
      version: 2,
    },
    location: { status: 'cell' },
    comment: {
      id: overrides.id,
      content,
      createdTime: overrides.createdTime ?? '2026-06-14T10:00:00Z',
      modifiedTime: overrides.modifiedTime ?? '2026-06-14T10:00:00Z',
      anchor: createCellCommentAnchor(cellId),
      author: { displayName: 'Tester' },
      resolved: false,
      replies: [],
      ...overrides,
    },
  }
}
