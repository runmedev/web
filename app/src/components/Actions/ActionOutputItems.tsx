import React from 'react'

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

function ActionOutputItemView({
  item,
  outputIndex,
  itemIndex,
}: {
  item: parser_pb.CellOutputItem
  outputIndex: number
  itemIndex: number
}) {
  const mime = item.mime || ''
  const text = formatOutputTextForDisplay(
    decodeOutputText(item.data ?? new Uint8Array()),
    mime
  )
  const isStreaming = item.metadata?.[IOPUB_INCOMPLETE_METADATA_KEY] === 'true'
  const hasIopubMetadata =
    item.metadata?.[IOPUB_INCOMPLETE_METADATA_KEY] === 'true' ||
    item.metadata?.[IOPUB_INCOMPLETE_METADATA_KEY] === 'false'

  let content: React.ReactNode = null

  if (mime === 'text/html') {
    content = (
      <iframe
        title={`cell-output-${outputIndex}-${itemIndex}`}
        sandbox="allow-scripts"
        srcDoc={text}
        className="h-[420px] w-full rounded-md border border-nb-cell-border bg-white"
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
        className="max-h-[480px] w-full rounded-md border border-nb-cell-border bg-white object-contain"
      />
    )
  } else {
    content = (
      <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-nb-text">
        {text}
      </pre>
    )
  }

  return (
    <div
      className="rounded-nb-sm border border-nb-border bg-nb-surface-2 p-3"
      data-testid="cell-output-item"
    >
      <div className="text-[10px] font-medium uppercase tracking-wide text-nb-text-faint">
        Output {outputIndex} / Item {itemIndex} - mime={mime}
        {hasIopubMetadata ? (isStreaming ? ' (streaming)' : ' (complete)') : ''}
      </div>
      <div className="mt-2">{content}</div>
    </div>
  )
}

export function ActionOutputItems({
  outputs,
  suppressStdText = false,
}: {
  outputs: parser_pb.CellOutput[]
  suppressStdText?: boolean
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
          />
        )
      })
      .filter(Boolean)
  )

  if (displayableItems.length === 0) {
    return null
  }

  return <div className="mt-2 space-y-2">{displayableItems}</div>
}
