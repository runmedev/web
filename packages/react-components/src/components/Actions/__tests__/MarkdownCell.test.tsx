/**
 * Tests for MarkdownCell component - Jupyter-style in-place markdown rendering.
 *
 * These tests verify:
 * 1. Markdown content renders correctly when in rendered mode
 * 2. Double-click transitions to edit mode
 * 3. Empty cells start in edit mode
 * 4. Keyboard accessibility (Enter/Space to edit)
 * 5. Content changes propagate correctly
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { create } from '@bufbuild/protobuf'
import React from 'react'

import { parser_pb } from '../../../runme/client'
import MarkdownCell from '../MarkdownCell'

// Mock the Editor component to avoid Monaco loading issues in tests
vi.mock('../Editor', () => ({
  default: ({
    id,
    value,
    onChange,
    onEnter,
  }: {
    id: string
    value: string
    language: string
    fontSize?: number
    fontFamily?: string
    onChange: (v: string) => void
    onEnter: () => void
  }) => (
    <div data-testid="mock-editor">
      <textarea
        data-testid={`editor-input-${id}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.ctrlKey) {
            onEnter()
          }
        }}
      />
    </div>
  ),
}))

// Mock CellConsole exports
vi.mock('../CellConsole', () => ({
  fontSettings: {
    fontSize: 14,
    fontFamily: 'monospace',
  },
}))

describe('MarkdownCell component', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders markdown content in rendered mode by default', () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'md-cell-1',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      value: '# Hello World\n\nThis is a test.',
      outputs: [],
      metadata: {},
    })

    render(<MarkdownCell cell={cell} />)

    // Should show rendered view, not editor
    expect(screen.getByTestId('markdown-rendered')).toBeInTheDocument()
    expect(screen.queryByTestId('markdown-editor')).not.toBeInTheDocument()

    // Should contain the rendered markdown text
    expect(screen.getByText('Hello World')).toBeInTheDocument()
  })

  it('starts in edit mode when cell is empty', () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'md-cell-empty',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      value: '',
      outputs: [],
      metadata: {},
    })

    render(<MarkdownCell cell={cell} />)

    // Should show editor for empty cells
    expect(screen.getByTestId('markdown-editor')).toBeInTheDocument()
    expect(screen.queryByTestId('markdown-rendered')).not.toBeInTheDocument()
  })

  it('switches to edit mode on double-click', async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'md-cell-2',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      value: '# Click me',
      outputs: [],
      metadata: {},
    })

    render(<MarkdownCell cell={cell} />)

    // Initially in rendered mode
    const renderedView = screen.getByTestId('markdown-rendered')
    expect(renderedView).toBeInTheDocument()

    // Double-click to enter edit mode
    await act(async () => {
      fireEvent.doubleClick(renderedView)
    })

    // Should now show editor
    expect(screen.getByTestId('markdown-editor')).toBeInTheDocument()
    expect(screen.queryByTestId('markdown-rendered')).not.toBeInTheDocument()
  })

  it('calls onCellChange when editor value changes', async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'md-cell-4',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      value: '',
      outputs: [],
      metadata: {},
    })
    const onCellChange = vi.fn()

    render(<MarkdownCell cell={cell} onCellChange={onCellChange} />)

    // Empty cell starts in edit mode
    const editorInput = screen.getByTestId('editor-input-md-editor-md-cell-4')

    // Type new content
    await act(async () => {
      fireEvent.change(editorInput, { target: { value: '# New Content' } })
    })

    // Should have called onCellChange with updated cell
    expect(onCellChange).toHaveBeenCalled()
    const updatedCell = onCellChange.mock.calls[0][0]
    expect(updatedCell.value).toBe('# New Content')
  })

  it('has correct data-testid attributes', () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'md-cell-debug',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      value: '# Debug Test',
      outputs: [],
      metadata: {},
    })

    render(<MarkdownCell cell={cell} />)

    const markdownCell = screen.getByTestId('markdown-cell')
    expect(markdownCell).toBeInTheDocument()
    expect(markdownCell).toHaveAttribute('data-rendered', 'true')
  })

  it('switches to edit mode on Enter key for accessibility', async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'md-cell-a11y',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      value: '# Accessible',
      outputs: [],
      metadata: {},
    })

    render(<MarkdownCell cell={cell} />)

    const renderedView = screen.getByTestId('markdown-rendered')

    // Press Enter to activate edit mode (a11y)
    await act(async () => {
      fireEvent.keyDown(renderedView, { key: 'Enter' })
    })

    // Should now show editor
    expect(screen.getByTestId('markdown-editor')).toBeInTheDocument()
  })

  it('switches to edit mode on Space key for accessibility', async () => {
    const cell = create(parser_pb.CellSchema, {
      refId: 'md-cell-space',
      kind: parser_pb.CellKind.MARKUP,
      languageId: 'markdown',
      value: '# Space Key',
      outputs: [],
      metadata: {},
    })

    render(<MarkdownCell cell={cell} />)

    const renderedView = screen.getByTestId('markdown-rendered')

    // Press Space to activate edit mode (a11y)
    await act(async () => {
      fireEvent.keyDown(renderedView, { key: ' ' })
    })

    // Should now show editor
    expect(screen.getByTestId('markdown-editor')).toBeInTheDocument()
  })

  it('returns null when cell is undefined', () => {
    const { container } = render(
      <MarkdownCell cell={undefined as unknown as parser_pb.Cell} />
    )
    expect(container.firstChild).toBeNull()
  })
})
