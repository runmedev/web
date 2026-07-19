import { create } from '@bufbuild/protobuf'

import { parser_pb } from '../runme/client'
import type { NotebookDataLike } from './runtime/runmeConsole'

export const MAX_EMBEDDED_IMAGE_BYTES = 10 * 1024 * 1024
export const LOCAL_IMAGE_ENDPOINT = '/__runme-dev/local-image'
const MAX_ERROR_DETAIL_BYTES = 4 * 1024

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

export type EmbeddedImageSource = string | Blob

export type EmbedImageOptions = {
  alt?: string
  name?: string
  signal?: AbortSignal
}

export type EmbeddedImage = {
  bytes: Uint8Array
  mimeType: string
  name: string
}

export type EmbedImageResult = {
  uri: string
  cell: parser_pb.Cell
}

function normalizeMimeType(value: string | null | undefined): string {
  return (value ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function extensionFromName(name: string): string {
  const normalized = name.trim().toLowerCase()
  const dot = normalized.lastIndexOf('.')
  return dot >= 0 ? normalized.slice(dot) : ''
}

function inferImageMimeType(name: string): string {
  return IMAGE_MIME_BY_EXTENSION[extensionFromName(name)] ?? ''
}

function baseName(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  const segment = normalized.split('/').pop()
  return segment || 'embedded-image'
}

function nameFromSource(source: string): string {
  if (source.startsWith('data:')) {
    return 'embedded-image'
  }
  try {
    const parsed = new URL(source, window.location.href)
    return baseName(decodeURIComponent(parsed.pathname))
  } catch {
    return baseName(source)
  }
}

function isAbsoluteLocalPath(source: string): boolean {
  return (
    source.startsWith('/') ||
    /^[a-zA-Z]:[\\/]/.test(source) ||
    source.startsWith('file://')
  )
}

function localPathFromSource(source: string): string {
  if (!source.startsWith('file://')) {
    return source
  }
  const url = new URL(source)
  const decoded = decodeURIComponent(url.pathname)
  return /^\/[a-zA-Z]:\//.test(decoded) ? decoded.slice(1) : decoded
}

function assertImageSize(size: number): void {
  if (size > MAX_EMBEDDED_IMAGE_BYTES) {
    throw new Error(
      `Image is too large (${size} bytes). The maximum embedded image size is ${MAX_EMBEDDED_IMAGE_BYTES} bytes.`
    )
  }
}

function throwIfImageEmbeddingAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return
  }
  throw (
    signal.reason ??
    new DOMException('Image embedding was aborted.', 'AbortError')
  )
}

function assertImageMimeType(
  mimeType: string | null | undefined,
  name: string
): string {
  const normalized = normalizeMimeType(mimeType) || inferImageMimeType(name)
  if (!normalized.startsWith('image/')) {
    throw new Error(
      `Unsupported image type ${mimeType || '(missing MIME type)'} for ${name}.`
    )
  }
  return normalized
}

async function imageFromBlob(
  blob: Blob,
  name: string,
  signal?: AbortSignal
): Promise<EmbeddedImage> {
  throwIfImageEmbeddingAborted(signal)
  assertImageSize(blob.size)
  const mimeType = assertImageMimeType(blob.type, name)
  const buffer =
    typeof blob.arrayBuffer === 'function'
      ? await blob.arrayBuffer()
      : await new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader()
          reader.onerror = () =>
            reject(reader.error ?? new Error('Failed to read image bytes.'))
          reader.onload = () => resolve(reader.result as ArrayBuffer)
          reader.readAsArrayBuffer(blob)
        })
  throwIfImageEmbeddingAborted(signal)
  const bytes = new Uint8Array(buffer)
  assertImageSize(bytes.byteLength)
  return {
    bytes,
    mimeType,
    name,
  }
}

async function readResponseBytes(
  response: Response,
  signal?: AbortSignal
): Promise<Uint8Array> {
  throwIfImageEmbeddingAborted(signal)
  const reader = response.body?.getReader()
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    throwIfImageEmbeddingAborted(signal)
    assertImageSize(bytes.byteLength)
    return bytes
  }

  const chunks: Uint8Array[] = []
  let totalBytes = 0
  const cancelReader = () => {
    void reader.cancel(signal?.reason).catch(() => undefined)
  }
  signal?.addEventListener('abort', cancelReader, { once: true })
  try {
    while (true) {
      const { done, value } = await reader.read()
      throwIfImageEmbeddingAborted(signal)
      if (done) {
        break
      }
      totalBytes += value.byteLength
      if (totalBytes > MAX_EMBEDDED_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined)
        assertImageSize(totalBytes)
      }
      chunks.push(value)
    }
  } finally {
    signal?.removeEventListener('abort', cancelReader)
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function readResponseErrorDetail(
  response: Response,
  signal?: AbortSignal
): Promise<string> {
  throwIfImageEmbeddingAborted(signal)
  const reader = response.body?.getReader()
  if (!reader) {
    return ''
  }

  const decoder = new TextDecoder()
  let detail = ''
  let totalBytes = 0
  const cancelReader = () => {
    void reader.cancel(signal?.reason).catch(() => undefined)
  }
  signal?.addEventListener('abort', cancelReader, { once: true })
  try {
    while (totalBytes < MAX_ERROR_DETAIL_BYTES) {
      const { done, value } = await reader.read()
      throwIfImageEmbeddingAborted(signal)
      if (done) {
        detail += decoder.decode()
        break
      }

      const remaining = MAX_ERROR_DETAIL_BYTES - totalBytes
      const chunk =
        value.byteLength > remaining ? value.subarray(0, remaining) : value
      totalBytes += chunk.byteLength
      detail += decoder.decode(chunk, { stream: true })

      if (
        value.byteLength > remaining ||
        totalBytes >= MAX_ERROR_DETAIL_BYTES
      ) {
        await reader.cancel().catch(() => undefined)
        detail += decoder.decode()
        break
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancelReader)
    reader.releaseLock()
  }
  return detail.trim()
}

async function imageFromResponse(
  response: Response,
  name: string,
  signal?: AbortSignal
): Promise<EmbeddedImage> {
  throwIfImageEmbeddingAborted(signal)
  if (!response.ok) {
    const detail = await readResponseErrorDetail(response, signal).catch(
      (error) => {
        throwIfImageEmbeddingAborted(signal)
        return String(error)
      }
    )
    throw new Error(
      `Failed to read image (${response.status}): ${detail || response.statusText}`
    )
  }
  const contentLength = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(contentLength) && contentLength > 0) {
    assertImageSize(contentLength)
  }
  const mimeType = assertImageMimeType(
    response.headers.get('content-type'),
    name
  )
  const bytes = await readResponseBytes(response, signal)
  return {
    bytes,
    mimeType,
    name,
  }
}

async function fetchImage(
  source: string,
  signal?: AbortSignal
): Promise<EmbeddedImage> {
  const name = nameFromSource(source)
  let response: Response
  try {
    response = await fetch(source, { signal })
  } catch (error) {
    throwIfImageEmbeddingAborted(signal)
    throw new Error(
      `Failed to fetch image ${source}. The URL may not permit browser requests: ${String(error)}`
    )
  }
  return imageFromResponse(response, name, signal)
}

async function readLocalImagePath(
  source: string,
  signal?: AbortSignal
): Promise<EmbeddedImage> {
  const localPath = localPathFromSource(source)
  const url = new URL(LOCAL_IMAGE_ENDPOINT, window.location.origin)
  url.searchParams.set('path', localPath)
  return imageFromResponse(
    await fetch(url.toString(), { signal }),
    baseName(localPath),
    signal
  )
}

export async function readEmbeddedImageSource(
  source: EmbeddedImageSource,
  options: Pick<EmbedImageOptions, 'signal'> = {}
): Promise<EmbeddedImage> {
  throwIfImageEmbeddingAborted(options.signal)
  if (source instanceof Blob) {
    const fileName =
      'name' in source && typeof source.name === 'string'
        ? source.name
        : 'embedded-image'
    return imageFromBlob(source, fileName, options.signal)
  }

  const trimmed = source.trim()
  if (!trimmed) {
    throw new Error(
      'An image URL, local path, data URL, File, or Blob is required.'
    )
  }

  if (isAbsoluteLocalPath(trimmed)) {
    return readLocalImagePath(trimmed, options.signal)
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed, window.location.href)
  } catch {
    throw new Error(`Invalid image source: ${trimmed}`)
  }
  if (!['http:', 'https:', 'data:', 'blob:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported image URL protocol: ${parsed.protocol}`)
  }
  return fetchImage(parsed.toString(), options.signal)
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function buildEmbeddedImageHtml(
  image: EmbeddedImage,
  options: EmbedImageOptions = {}
): string {
  const name = options.name?.trim() || image.name
  const alt = options.alt ?? name
  const dataUrl = `data:${image.mimeType};base64,${bytesToBase64(image.bytes)}`
  return [
    '<figure style="margin:0">',
    `  <img src="${dataUrl}" alt="${escapeHtmlAttribute(alt)}" style="display:block;max-width:100%;height:auto" />`,
    '</figure>',
  ].join('\n')
}

export async function embedImageInNotebook(
  notebook: NotebookDataLike,
  source: EmbeddedImageSource,
  options: EmbedImageOptions = {}
): Promise<EmbedImageResult> {
  if (typeof notebook.appendCell !== 'function') {
    throw new Error('Notebook does not support appending image cells.')
  }

  const image = await readEmbeddedImageSource(source, {
    signal: options.signal,
  })
  throwIfImageEmbeddingAborted(options.signal)
  const inserted = notebook.appendCell(parser_pb.CellKind.CODE, 'html')
  try {
    const updated = create(parser_pb.CellSchema, inserted)
    updated.value = buildEmbeddedImageHtml(image, options)
    updated.metadata = {
      ...(updated.metadata ?? {}),
      'runme.dev/embeddedImage': 'true',
      'runme.dev/embeddedImageMimeType': image.mimeType,
      'runme.dev/embeddedImageName': options.name?.trim() || image.name,
    }
    throwIfImageEmbeddingAborted(options.signal)
    notebook.updateCell(updated)
    return {
      uri: notebook.getUri(),
      cell: updated,
    }
  } catch (error) {
    notebook.removeCell?.(inserted.refId)
    throw error
  }
}

function pickImageWithFileInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.style.display = 'none'
    input.onchange = () => {
      const file = input.files?.[0] ?? null
      input.remove()
      resolve(file)
    }
    input.oncancel = () => {
      input.remove()
      resolve(null)
    }
    document.body.appendChild(input)
    input.click()
  })
}

export async function pickImageFromLocalFilesystem(): Promise<File | null> {
  return pickImageWithFileInput()
}

export function isSupportedImageFile(file: File): boolean {
  return (
    normalizeMimeType(file.type).startsWith('image/') ||
    Boolean(inferImageMimeType(file.name))
  )
}
