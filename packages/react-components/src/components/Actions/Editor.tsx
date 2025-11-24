import { memo, useEffect, useRef, useState } from 'react'

import MonacoEditor from '@monaco-editor/react'

const theme = 'vs-dark'

// Common programming languages supported by Monaco Editor
const LANGUAGES = [
  { value: 'plaintext', label: 'Text' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
  { value: 'java', label: 'Java' },
  { value: 'csharp', label: 'C#' },
  { value: 'cpp', label: 'C++' },
  { value: 'c', label: 'C' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'php', label: 'PHP' },
  { value: 'shellscript', label: 'Shell' },
  { value: 'bash', label: 'Bash' },
  { value: 'powershell', label: 'PowerShell' },
  { value: 'json', label: 'JSON' },
  { value: 'yaml', label: 'YAML' },
  { value: 'xml', label: 'XML' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'scss', label: 'SCSS' },
  { value: 'sql', label: 'SQL' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'dockerfile', label: 'Dockerfile' },
  { value: 'makefile', label: 'Makefile' },
  { value: 'ini', label: 'INI' },
  { value: 'toml', label: 'TOML' },
]

// Map common shorthand language identifiers to their full Monaco language IDs
const LANGUAGE_ALIASES: Record<string, string> = {
  sh: 'shellscript',
  bash: 'shellscript',
  shell: 'shellscript',
  zsh: 'shellscript',
  fish: 'shellscript',
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  rb: 'ruby',
  md: 'markdown',
  yml: 'yaml',
  ps1: 'powershell',
  ps: 'powershell',
  txt: 'plaintext',
}

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
    showLanguageSelector = false,
  }: {
    id: string
    value: string
    language: string
    fontSize?: number
    fontFamily?: string
    onChange: (value: string) => void
    onEnter: () => void
    showLanguageSelector?: boolean
  }) => {
    // Store the latest onEnter in a ref to ensure late binding
    const onEnterRef = useRef(onEnter)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const editorRef = useRef<any>(null)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const monacoRef = useRef<any>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const [height, setHeight] = useState('280px')
    const [isResizing, setIsResizing] = useState(false)
    const [currentLanguage, setCurrentLanguage] = useState(language)
    const startYRef = useRef(0)
    const startHeightRef = useRef(0)

    // Keep the ref updated with the latest onEnter
    useEffect(() => {
      onEnterRef.current = onEnter
    }, [onEnter])

    // Sync currentLanguage when language prop changes and update editor
    useEffect(() => {
      setCurrentLanguage(language)

      // Update the editor's language if it's already mounted
      if (editorRef.current && monacoRef.current) {
        const model = editorRef.current.getModel()
        if (model) {
          monacoRef.current.editor.setModelLanguage(model, language)
        }
      }
    }, [language])

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
      monacoRef.current = monaco

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

    // Normalize language identifier (handle shorthands)
    const normalizedLanguage =
      currentLanguage && LANGUAGE_ALIASES[currentLanguage.toLowerCase()]
        ? LANGUAGE_ALIASES[currentLanguage.toLowerCase()]
        : currentLanguage || 'plaintext'

    // Find the display label for the current language
    const currentLanguageLabel =
      LANGUAGES.find((lang) => lang.value === normalizedLanguage)?.label ||
      currentLanguage

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
              onChange?.(v)
            }}
            onMount={editorDidMount}
            className="rounded-lg"
            wrapperProps={{ className: 'rounded-lg' }}
          />
          {showLanguageSelector && (
            <div className="absolute bottom-2 right-2 z-10">
              <div className="px-2 py-1 text-xs bg-gray-800/90 border border-gray-700/50 rounded text-gray-300 backdrop-blur-sm">
                {currentLanguageLabel}
              </div>
            </div>
          )}
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
