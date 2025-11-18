import { memo, useEffect, useRef, useState } from 'react'

import MonacoEditor from '@monaco-editor/react'

const theme = 'vs-dark'

// Editor component for editing code which won't re-render unless the value changes
const Editor = memo(
  ({
    id,
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
    // Store the latest onEnter in a ref to ensure late binding
    const onEnterRef = useRef(onEnter)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const editorRef = useRef<any>(null)
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
        if (!isResizing) {
          return
        }

        const deltaY = e.clientY - startYRef.current
        const newHeight = Math.max(100, startHeightRef.current + deltaY)
        setHeight(`${newHeight}px`)

        // Resize the editor
        if (editorRef.current) {
          editorRef.current.layout()
        }
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const editorDidMount = (editor: any, monaco: any) => {
      editorRef.current = editor

      if (!monaco?.editor) {
        return
      }
      monaco.editor.setTheme(theme)

      if (!editor) {
        return
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor.onKeyDown((event: any) => {
        if (event.ctrlKey && event.keyCode === 3) {
          // Use the ref to ensure we always have the latest onEnter
          onEnterRef.current()
        }
      })
      // if the value is empty, focus the editor
      if (value === '') {
        editor.focus()
      }
    }

    const handleResizeStart = (e: React.MouseEvent) => {
      setIsResizing(true)
      startYRef.current = e.clientY
      startHeightRef.current = containerRef.current?.clientHeight || 140
      document.body.style.cursor = 'ns-resize'
      e.preventDefault()
    }

    return (
      <div className="pb-1 w-full" ref={containerRef}>
        <div className="rounded-md overflow-hidden relative">
          <MonacoEditor
            key={id}
            height={height}
            // width="100%"
            defaultLanguage={language}
            value={value}
            options={{
              scrollbar: {
                alwaysConsumeMouseWheel: false,
              },
              minimap: { enabled: false },
              theme,
              wordWrap: 'wordWrapColumn',
              fontSize,
              fontFamily,
              lineHeight: 20,
              automaticLayout: true,
            }}
            onChange={(v) => {
              if (!v) {
                return
              }
              value = v
              onChange?.(v)
            }}
            onMount={editorDidMount}
            className="rounded-lg"
            wrapperProps={{ className: 'rounded-lg' }}
          />
        </div>
        <div
          className="h-2 w-full cursor-ns-resize"
          onMouseDown={handleResizeStart}
        />
      </div>
    )
  },
  (prevProps, nextProps) => {
    return prevProps.value === nextProps.value
  }
)

export default Editor
