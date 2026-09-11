// @vitest-environment jsdom
import React from 'react'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Editor from './Editor'

const state = vi.hoisted(() => ({
  editor: null as any,
  action: null as any,
  dispose: vi.fn(),
}))
vi.mock('use-resize-observer', () => ({
  default: () => ({ ref: () => {}, width: 400 }),
}))
vi.mock('@monaco-editor/react', () => ({
  default: ({ onMount }: any) => {
    React.useEffect(() => {
      onMount(state.editor, {
        editor: { defineTheme: vi.fn(), setTheme: vi.fn() },
        KeyMod: { CtrlCmd: 2048, Alt: 512 },
        KeyCode: { KeyM: 43 },
      })
    }, [])
    return <div className="monaco-editor" />
  },
}))

beforeEach(() => {
  state.action = null
  state.dispose.mockReset()
  const source = 'a😀 first\r\nsecond'
  state.editor = {
    getModel: () => ({
      getValue: () => source,
      getOffsetAt: ({ lineNumber, column }: any) =>
        (lineNumber === 1 ? 0 : 11) + column - 1,
    }),
    getSelection: () => ({
      isEmpty: () => false,
      getStartPosition: () => ({ lineNumber: 1, column: 2 }),
      getEndPosition: () => ({ lineNumber: 2, column: 7 }),
    }),
    addAction: vi.fn((action) => {
      state.action = action
      return { dispose: state.dispose }
    }),
    onKeyDown: vi.fn(),
    onDidContentSizeChange: vi.fn(),
    onDidFocusEditorText: vi.fn(),
    getContentHeight: () => 120,
    layout: vi.fn(),
    getLayoutInfo: () => ({ width: 400 }),
  }
})
const props = {
  id: 'cell',
  value: 'stale React source',
  language: 'python',
  onChange: vi.fn(),
  onEnter: vi.fn(),
}

describe('editor range comments', () => {
  it.each(['python', 'markdown'])(
    'captures the current %s source and UTF-16 multiline selection',
    (language) => {
      const onCommentSelection = vi.fn()
      render(
        <Editor
          {...props}
          language={language}
          onCommentSelection={onCommentSelection}
        />
      )
      expect(state.action.precondition).toBe('editorHasSelection')
      act(() => state.action.run())
      expect(onCommentSelection).toHaveBeenCalledWith({
        source: 'a😀 first\r\nsecond',
        range: { start: 1, end: 17 },
      })
    }
  )
  it('ignores an empty selection even when invoked programmatically', () => {
    const onCommentSelection = vi.fn()
    render(<Editor {...props} onCommentSelection={onCommentSelection} />)
    state.editor.getSelection = () => ({ isEmpty: () => true })
    act(() => state.action.run())
    expect(onCommentSelection).not.toHaveBeenCalled()
  })
  it('registers when comments become available and uses the latest callback', () => {
    const first = vi.fn(),
      second = vi.fn()
    const view = render(<Editor {...props} />)
    expect(state.editor.addAction).not.toHaveBeenCalled()
    view.rerender(<Editor {...props} onCommentSelection={first} />)
    act(() => state.action.run())
    view.rerender(<Editor {...props} onCommentSelection={second} />)
    act(() => state.action.run())
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(state.dispose).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(state.dispose).toHaveBeenCalledTimes(2)
  })
})
