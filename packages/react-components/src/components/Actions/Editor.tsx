import { memo, useEffect, useRef, useState } from 'react'

import * as monaco from 'monaco-editor'

const theme = 'vs-dark'

// Editor component for editing code which won't re-render unless the value changes
const Editor = memo(
  ({
    id: _id, // Suppress unused parameter warning
    value,
    language,
    fontSize = 14,
    fontFamily = 'monospace',
    onChange,
    onEnter,
  }: {
    id: string
    value: string
    language: string
    fontSize?: number
    fontFamily?: string
    onChange: (value: string) => void
    onEnter: () => void
  }) => {
    const onEnterRef = useRef(onEnter)
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const [height, setHeight] = useState('140px')
    const [isResizing, setIsResizing] = useState(false)
    const startYRef = useRef(0)
    const startHeightRef = useRef(0)

    // Keep the ref updated with the latest onEnter
    useEffect(() => {
      onEnterRef.current = onEnter
    }, [onEnter])

    // Handle resize events
    useEffect(() => {
      const handleMouseMove = (e: MouseEvent) => {
        if (!isResizing) return
        const deltaY = e.clientY - startYRef.current
        const newHeight = Math.max(100, startHeightRef.current + deltaY)
        setHeight(`${newHeight}px`)
        if (editorRef.current) editorRef.current.layout()
      }
      const handleMouseUp = () => {
        setIsResizing(false)
        document.body.style.cursor = 'default'
      }
      if (isResizing) {
        document.addEventListener('mousemove', handleMouseMove)
        document.addEventListener('mouseup', handleMouseUp)
      }
      return () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }
    }, [isResizing])

    // Initialize Monaco Editor
    useEffect(() => {
      if (!containerRef.current) return
      if (editorRef.current) return

      // Monaco Editor will use bundled workers by default

      const editor = monaco.editor.create(containerRef.current, {
        value,
        language,
        theme,
        scrollbar: { alwaysConsumeMouseWheel: false },
        minimap: { enabled: false },
        wordWrap: 'wordWrapColumn',
        fontSize,
        fontFamily,
        lineHeight: 20,
      })
      editorRef.current = editor

      // Set theme
      monaco.editor.setTheme(theme)

      // onChange
      const changeDisposable = editor.onDidChangeModelContent(() => {
        const newValue = editor.getValue()
        if (newValue !== value) onChange?.(newValue)
      })

      // onEnter (Ctrl+C)
      const keydownDisposable = editor.onKeyDown((event) => {
        if (event.ctrlKey && event.keyCode === 3) {
          onEnterRef.current()
        }
      })

      // Focus if value is empty
      if (value === '') editor.focus()

      return () => {
        changeDisposable.dispose()
        keydownDisposable.dispose()
        editor.dispose()
      }
      // Only run once on mount
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Update value if prop changes
    useEffect(() => {
      if (editorRef.current && editorRef.current.getValue() !== value) {
        editorRef.current.setValue(value)
      }
    }, [value])

    // Resize handler
    const handleResizeStart = (e: React.MouseEvent) => {
      setIsResizing(true)
      startYRef.current = e.clientY
      startHeightRef.current = containerRef.current?.clientHeight || 140
      document.body.style.cursor = 'ns-resize'
      e.preventDefault()
    }

    return (
      <div className="pb-1 w-full">
        <div className="rounded-md overflow-hidden">
          <div
            ref={containerRef}
            style={{ height, width: '100%' }}
            className="rounded-lg"
          />
        </div>
        <div
          className="h-2 w-full cursor-ns-resize"
          onMouseDown={handleResizeStart}
        />
      </div>
    )
  },
  (prevProps, nextProps) => prevProps.value === nextProps.value
)

export default Editor
