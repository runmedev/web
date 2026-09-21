import { HtmlOutput } from './HtmlOutput'
import React from 'react'
import { LinkIcon } from '@heroicons/react/20/solid'

import { MimeType, parser_pb } from '../../runme/client'
import { IOPUB_INCOMPLETE_METADATA_KEY } from '../../lib/ipykernel'
import { stripAnsiControlSequences } from '../../lib/ansi'

const outputTextDecoder = new TextDecoder()
const ALWAYS_SKIP_MIMES = new Set<string>([MimeType.StatefulRunmeTerminal])
const ANSI_STRIPPED_TEXT_MIMES = new Set<string>([
  MimeType.VSCodeNotebookStdOut,
  MimeType.VSCodeNotebookStdErr,
  'text/plain',
])

function normalizeBinaryData(
  data?: Uint8Array | ArrayLike<number> | null
): Uint8Array {
  if (!data) {
    return new Uint8Array()
  }
  return data instanceof Uint8Array ? data : Uint8Array.from(data)
}

function decodeOutputText(
  data?: Uint8Array | ArrayLike<number> | null
): string {
  const normalized = normalizeBinaryData(data)
  if (normalized.length === 0) {
    return ''
  }
  try {
    return outputTextDecoder.decode(normalized)
  } catch {
    return ''
  }
}

function formatOutputTextForDisplay(text: string, mime: string): string {
  return ANSI_STRIPPED_TEXT_MIMES.has(mime)
    ? stripAnsiControlSequences(text)
    : text
}

function uint8ArrayToBase64(
  data?: Uint8Array | ArrayLike<number> | null
): string {
  const normalized = normalizeBinaryData(data)
  if (normalized.length === 0) {
    return ''
  }

  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < normalized.length; i += chunkSize) {
    const chunk = normalized.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  if (typeof globalThis.btoa === 'function') {
    return globalThis.btoa(binary)
  }
  return ''
}

export function ActionOutputItemView({
  item,
  outputIndex,
  itemIndex,
  onCopyReference,
  onDoubleClick,
}: {
  item: parser_pb.CellOutputItem
  outputIndex: number
  itemIndex: number
  onCopyReference?: () => void
  onDoubleClick?: () => void
}) {
  const mime = item.mime || ''
  const text = formatOutputTextForDisplay(
    decodeOutputText(item.data ?? new Uint8Array()),
    mime
  )
  const isStreaming = item.metadata?.[IOPUB_INCOMPLETE_METADATA_KEY] === 'true'

  let content: React.ReactNode = null

  if (mime === 'text/html') {
    content = (
      <HtmlOutput
        html={text}
        title={`cell-output-${outputIndex}-${itemIndex}`}
        onDoubleClick={onDoubleClick}
      />
    )
  } else if (
    mime === 'image/png' ||
    mime === 'image/jpeg' ||
    mime === 'image/svg+xml'
  ) {
    const base64 = uint8ArrayToBase64(item.data ?? new Uint8Array())
    const src = `data:${mime};base64,${base64}`
    content = (
      <img
        alt={`Cell output ${outputIndex}-${itemIndex}`}
        src={src}
        className="block h-auto max-w-full object-contain"
      />
    )
  } else {
    content = (
      <pre className="m-0 whitespace-pre-wrap p-3 [overflow-wrap:anywhere] text-xs leading-relaxed text-nb-text">
        {text}
      </pre>
    )
  }

  return (
    <div
      className="relative min-w-0 overflow-hidden rounded-nb-md border border-nb-border-strong bg-white"
      data-testid="cell-output-item"
      role="group"
      aria-label={`Output ${outputIndex}, item ${itemIndex}${isStreaming ? ', streaming' : ''}`}
    >
      {mime === 'text/html' ? <div className="p-2">{content}</div> : content}
      {onCopyReference && (
        <button
          type="button"
          className="icon-btn absolute right-1 top-1 z-10 h-7 w-7 rounded bg-white/90 opacity-70 hover:opacity-100 focus-visible:opacity-100"
          onClick={onCopyReference}
          aria-label={`Copy output link ${outputIndex}.${itemIndex}`}
          title="Copy output link"
        >
          <LinkIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

export function ActionOutputItems({
  outputs,
  suppressStdText = false,
  onCopyReference,
}: {
  outputs: parser_pb.CellOutput[]
  suppressStdText?: boolean
  onCopyReference?: (outputIndex: number, itemIndex: number) => void
}) {
  const hasTerminalOutput = outputs.some((output) =>
    (output.items ?? []).some(
      (item) => item?.mime === MimeType.StatefulRunmeTerminal
    )
  )

  const displayableItems = outputs.flatMap((output, outputIndex) =>
    (output.items ?? [])
      .map((item, itemIndex) => {
        if (!item) {
          return null
        }
        const mime = item.mime || ''
        if (ALWAYS_SKIP_MIMES.has(mime)) {
          return null
        }
        if (
          (hasTerminalOutput || suppressStdText) &&
          (mime === MimeType.VSCodeNotebookStdOut ||
            mime === MimeType.VSCodeNotebookStdErr)
        ) {
          return null
        }
        if (normalizeBinaryData(item.data).length === 0) {
          return null
        }
        return (
          <ActionOutputItemView
            key={`${outputIndex}-${itemIndex}-${item.mime}`}
            item={item}
            outputIndex={outputIndex}
            itemIndex={itemIndex}
            onCopyReference={
              onCopyReference
                ? () => onCopyReference(outputIndex, itemIndex)
                : undefined
            }
          />
        )
      })
      .filter(Boolean)
  )

  if (displayableItems.length === 0) {
    return null
  }

  return <>{displayableItems}</>
}
