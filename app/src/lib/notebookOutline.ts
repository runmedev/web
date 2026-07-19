import { parser_pb } from '../contexts/CellContext'
import { isMarkdownLanguageId } from './cellContent'

export type NotebookOutlineEntry = {
  cellRefId: string
  level: number
  line: number
  text: string
}

type OutlineCell = Pick<
  parser_pb.Cell,
  'kind' | 'languageId' | 'refId' | 'value'
>

const atxHeadingPattern = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/
const setextHeadingPattern = /^ {0,3}(=+|-+)[ \t]*$/
const fencePattern = /^ {0,3}(`{3,}|~{3,})(.*)$/

function normalizeAtxHeading(value: string): string {
  return value.replace(/[ \t]+#+[ \t]*$/, '').trim()
}

function isSetextHeadingText(value: string): boolean {
  const trimmed = value.trim()
  return Boolean(
    trimmed &&
      !atxHeadingPattern.test(value) &&
      !fencePattern.test(value) &&
      !/^ {0,3}(?:>|[-+*][ \t])/.test(value)
  )
}

function extractCellHeadings(cell: OutlineCell): NotebookOutlineEntry[] {
  const entries: NotebookOutlineEntry[] = []
  const lines = cell.value.split(/\r?\n/)
  let fenceCharacter: '`' | '~' | null = null
  let fenceLength = 0

  lines.forEach((line, index) => {
    const fenceMatch = line.match(fencePattern)
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? ''
      const markerCharacter = marker[0] as '`' | '~'
      if (!fenceCharacter) {
        fenceCharacter = markerCharacter
        fenceLength = marker.length
      } else if (
        markerCharacter === fenceCharacter &&
        marker.length >= fenceLength &&
        (fenceMatch[2] ?? '').trim() === ''
      ) {
        fenceCharacter = null
        fenceLength = 0
      }
      return
    }

    if (fenceCharacter) {
      return
    }

    const atxMatch = line.match(atxHeadingPattern)
    if (atxMatch) {
      const text = normalizeAtxHeading(atxMatch[2] ?? '')
      if (text) {
        entries.push({
          cellRefId: cell.refId,
          level: atxMatch[1]?.length ?? 1,
          line: index + 1,
          text,
        })
      }
      return
    }

    const setextMatch = line.match(setextHeadingPattern)
    const previousLine = lines[index - 1]
    if (
      setextMatch &&
      previousLine !== undefined &&
      isSetextHeadingText(previousLine)
    ) {
      entries.push({
        cellRefId: cell.refId,
        level: setextMatch[1]?.startsWith('=') ? 1 : 2,
        line: index,
        text: previousLine.trim(),
      })
    }
  })

  return entries
}

export function extractNotebookOutline(
  cells: readonly OutlineCell[]
): NotebookOutlineEntry[] {
  return cells.flatMap((cell) => {
    const isMarkdownCell =
      cell.kind === parser_pb.CellKind.MARKUP ||
      isMarkdownLanguageId(cell.languageId)
    if (!isMarkdownCell || !cell.refId) {
      return []
    }
    return extractCellHeadings(cell)
  })
}
