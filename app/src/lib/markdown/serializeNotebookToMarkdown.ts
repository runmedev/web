import { MimeType, parser_pb } from '../../runme/client'

const IOPUB_MIME_TYPE = 'application/vnd.jupyter.iopub+json'

const outputTextDecoder = new TextDecoder()

const MARKDOWN_LANGUAGES = new Set(['markdown', 'md'])
const INTERNAL_SKIP_MIMES = new Set<string>([
  MimeType.StatefulRunmeOutputItems,
  MimeType.StatefulRunmeTerminal,
])

export function serializeNotebookToMarkdown(
  notebook: parser_pb.Notebook
): string {
  const parts = notebook.cells
    .map((cell) => serializeCell(cell))
    .filter((part) => part.trim().length > 0)

  if (parts.length === 0) {
    return ''
  }

  return `${parts.join('\n\n')}\n`
}

function serializeCell(cell: parser_pb.Cell): string {
  const body = isMarkupCell(cell)
    ? normalizeMarkupCell(cell.value)
    : renderFencedBlock(cell.value, normalizeCodeFenceLanguage(cell.languageId))
  const outputs = serializeCellOutputs(cell.outputs ?? [])
  return [body, outputs].filter(Boolean).join('\n\n')
}

function isMarkupCell(cell: parser_pb.Cell): boolean {
  if (cell.kind === parser_pb.CellKind.MARKUP) {
    return true
  }
  return MARKDOWN_LANGUAGES.has(cell.languageId.trim().toLowerCase())
}

function normalizeMarkupCell(value: string): string {
  return value.replace(/\s+$/u, '')
}

function normalizeCodeFenceLanguage(languageId: string): string {
  return languageId.trim().toLowerCase()
}

function serializeCellOutputs(outputs: parser_pb.CellOutput[]): string {
  const rendered = outputs.flatMap((output) =>
    (output.items ?? [])
      .map((item) => serializeOutputItem(item))
      .filter((value): value is string => Boolean(value))
  )

  return rendered.join('\n\n')
}

function serializeOutputItem(item: parser_pb.CellOutputItem): string | null {
  const mime = (item.mime ?? '').trim()
  if (!mime || INTERNAL_SKIP_MIMES.has(mime)) {
    return null
  }

  if (!isTextLikeMime(mime)) {
    return null
  }

  const text = decodeOutputText(item.data ?? new Uint8Array())
  if (!text) {
    return null
  }

  return renderFencedBlock(text, languageForOutputMime(mime))
}

function isTextLikeMime(mime: string): boolean {
  if (
    mime === MimeType.VSCodeNotebookStdOut ||
    mime === MimeType.VSCodeNotebookStdErr
  ) {
    return true
  }
  if (mime === IOPUB_MIME_TYPE) {
    return true
  }
  if (mime.startsWith('text/')) {
    return true
  }
  if (mime === 'application/json' || mime.endsWith('+json')) {
    return true
  }
  if (
    mime === 'application/javascript' ||
    mime === 'application/x-javascript'
  ) {
    return true
  }
  if (mime === 'application/xml' || mime.endsWith('+xml')) {
    return true
  }
  if (mime === 'application/sql') {
    return true
  }
  if (mime === 'application/yaml' || mime === 'application/x-yaml') {
    return true
  }
  return false
}

function languageForOutputMime(mime: string): string {
  switch (mime) {
    case MimeType.VSCodeNotebookStdOut:
      return 'stdout'
    case MimeType.VSCodeNotebookStdErr:
      return 'stderr'
    case IOPUB_MIME_TYPE:
    case 'application/json':
      return 'json'
    case 'text/html':
      return 'html'
    case 'application/javascript':
    case 'application/x-javascript':
      return 'javascript'
    case 'application/xml':
      return 'xml'
    case 'application/sql':
      return 'sql'
    case 'application/yaml':
    case 'application/x-yaml':
      return 'yaml'
    default:
      if (mime.startsWith('text/')) {
        return mime.slice('text/'.length)
      }
      if (mime.endsWith('+json')) {
        return 'json'
      }
      if (mime.endsWith('+xml')) {
        return 'xml'
      }
      return ''
  }
}

function decodeOutputText(data: Uint8Array): string {
  if (!(data instanceof Uint8Array) || data.length === 0) {
    return ''
  }
  try {
    return outputTextDecoder.decode(data).replace(/\s+$/u, '')
  } catch {
    return ''
  }
}

function renderFencedBlock(content: string, language = ''): string {
  const fence = pickFence(content)
  const info = language ? `${language}` : ''
  return `${fence}${info}\n${content}\n${fence}`
}

function pickFence(content: string): string {
  const matches: string[] = content.match(/`+/gu) ?? []
  const longest = matches.reduce((max, run) => Math.max(max, run.length), 0)
  return '`'.repeat(Math.max(3, longest + 1))
}
