import { create } from '@bufbuild/protobuf'

import { parser_pb } from '../runme/client'

export const LINKED_RESOURCE_LANGUAGE_ID = 'runme-resource'
export const LINKED_RESOURCE_METADATA_KEY = 'runme.dev/linkedResource'
export const LINKED_RESOURCE_VERSION_METADATA_KEY =
  'runme.dev/linkedResourceVersion'

export type LinkedResourceProvider = 'google-drive' | 'https'
export type LinkedResourcePresentationMode =
  | 'auto'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'link'

export type LinkedResourceV1 = {
  version: 1
  source: {
    provider: LinkedResourceProvider
    uri: string
  }
  presentation: {
    mode: LinkedResourcePresentationMode
    title?: string
    altText?: string
    loop?: boolean
    muted?: boolean
  }
  hints?: {
    name?: string
    mimeType?: string
    sizeBytes?: number
  }
}

export type LinkedResourceRenderer =
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'link'

export type LinkedResourceErrorCode =
  | 'AUTH_REQUIRED'
  | 'ACCESS_DENIED'
  | 'DOWNLOAD_RESTRICTED'
  | 'NOT_FOUND'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'OPFS_UNAVAILABLE'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'CACHE_CORRUPT'
  | 'MEDIA_TOO_LARGE_FOR_FALLBACK'
  | 'DOWNLOAD_INTERRUPTED'
  | 'UPLOAD_INTERRUPTED'
  | 'RESOURCE_CHANGED'
  | 'PROVIDER_UNAVAILABLE'

export class LinkedResourceError extends Error {
  constructor(
    readonly code: LinkedResourceErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message)
    this.name = 'LinkedResourceError'
    if (options && 'cause' in options) {
      ;(this as Error & { cause?: unknown }).cause = options.cause
    }
  }
}

const PRESENTATION_MODES = new Set<LinkedResourcePresentationMode>([
  'auto',
  'image',
  'video',
  'audio',
  'document',
  'link',
])

const SAFE_IMAGE_MIME_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/x-icon',
])

const SAFE_VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/ogg',
  'video/quicktime',
  'video/webm',
])

const SAFE_AUDIO_MIME_TYPES = new Set([
  'audio/aac',
  'audio/flac',
  'audio/m4a',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
])

const GOOGLE_WORKSPACE_MIME_PREFIX = 'application/vnd.google-apps.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new LinkedResourceError(
      'UNSUPPORTED_MEDIA_TYPE',
      `${field} must be a string`
    )
  }
  const normalized = value.trim()
  return normalized || undefined
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'boolean') {
    throw new LinkedResourceError(
      'UNSUPPORTED_MEDIA_TYPE',
      `${field} must be a boolean`
    )
  }
  return value
}

function normalizeHttpsUri(uri: unknown, provider: LinkedResourceProvider) {
  if (typeof uri !== 'string' || !uri.trim()) {
    throw new LinkedResourceError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Linked resource URI is required'
    )
  }
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch (error) {
    throw new LinkedResourceError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Linked resource URI must be a valid URL',
      { cause: error }
    )
  }
  if (parsed.protocol !== 'https:') {
    throw new LinkedResourceError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Linked resources require an HTTPS URL'
    )
  }
  if (provider === 'google-drive') {
    const fileId = parseGoogleDriveFileId(parsed.toString())
    const resourceKey = parsed.searchParams.get('resourcekey') ?? undefined
    return canonicalGoogleDriveFileUrl(fileId, resourceKey)
  }
  return parsed.toString()
}

export function parseGoogleDriveFileId(uri: string): string {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch (error) {
    throw new LinkedResourceError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Google Drive resource URI is invalid',
      { cause: error }
    )
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'drive.google.com') {
    throw new LinkedResourceError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Google Drive resource must use https://drive.google.com'
    )
  }
  const pathMatch = parsed.pathname.match(/\/file\/d\/([^/]+)/)
  const legacyId =
    parsed.pathname === '/open' || parsed.pathname === '/uc'
      ? parsed.searchParams.get('id')
      : null
  const fileId = pathMatch?.[1] ?? legacyId
  if (!fileId || !/^[A-Za-z0-9_-]+$/.test(fileId)) {
    throw new LinkedResourceError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Google Drive resource URL does not contain a valid file ID'
    )
  }
  return fileId
}

/** Builds a stable Drive file URL while retaining its access resource key. */
export function canonicalGoogleDriveFileUrl(
  fileId: string,
  resourceKey?: string
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(fileId)) {
    throw new LinkedResourceError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Google Drive file ID is invalid'
    )
  }
  if (resourceKey && !/^[A-Za-z0-9_-]+$/.test(resourceKey)) {
    throw new LinkedResourceError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Google Drive resource key is invalid'
    )
  }
  const url = new URL(`https://drive.google.com/file/d/${fileId}/view`)
  if (resourceKey) {
    url.searchParams.set('resourcekey', resourceKey)
  }
  return url.toString()
}

export function parseLinkedResource(value: string): LinkedResourceV1 {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new LinkedResourceError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Linked resource cell contains invalid JSON',
      { cause: error }
    )
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    throw new LinkedResourceError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Unsupported linked resource version'
    )
  }
  if (!isRecord(parsed.source) || !isRecord(parsed.presentation)) {
    throw new LinkedResourceError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Linked resource source and presentation are required'
    )
  }
  const provider = parsed.source.provider
  if (provider !== 'google-drive' && provider !== 'https') {
    throw new LinkedResourceError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Unsupported linked resource provider'
    )
  }
  const mode = parsed.presentation.mode
  if (
    typeof mode !== 'string' ||
    !PRESENTATION_MODES.has(mode as LinkedResourcePresentationMode)
  ) {
    throw new LinkedResourceError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Unsupported linked resource presentation mode'
    )
  }
  const hints = parsed.hints
  if (hints !== undefined && !isRecord(hints)) {
    throw new LinkedResourceError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Linked resource hints must be an object'
    )
  }
  const sizeBytes = hints?.sizeBytes
  if (
    sizeBytes !== undefined &&
    (typeof sizeBytes !== 'number' ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0)
  ) {
    throw new LinkedResourceError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Linked resource sizeBytes must be a non-negative integer'
    )
  }

  return {
    version: 1,
    source: {
      provider,
      uri: normalizeHttpsUri(parsed.source.uri, provider),
    },
    presentation: {
      mode: mode as LinkedResourcePresentationMode,
      title: optionalString(parsed.presentation.title, 'presentation.title'),
      altText: optionalString(
        parsed.presentation.altText,
        'presentation.altText'
      ),
      loop: optionalBoolean(parsed.presentation.loop, 'presentation.loop'),
      muted: optionalBoolean(parsed.presentation.muted, 'presentation.muted'),
    },
    ...(hints
      ? {
          hints: {
            name: optionalString(hints.name, 'hints.name'),
            mimeType: optionalString(hints.mimeType, 'hints.mimeType'),
            sizeBytes: sizeBytes as number | undefined,
          },
        }
      : {}),
  }
}

export function isLinkedResourceLanguageId(
  languageId?: string | null
): boolean {
  return (languageId ?? '').trim().toLowerCase() === LINKED_RESOURCE_LANGUAGE_ID
}

export function isLinkedResourceCell(cell?: parser_pb.Cell | null): boolean {
  return Boolean(
    cell &&
      cell.kind === parser_pb.CellKind.CODE &&
      isLinkedResourceLanguageId(cell.languageId)
  )
}

export function createLinkedResourceCell(
  resource: LinkedResourceV1
): parser_pb.Cell {
  const normalized = parseLinkedResource(JSON.stringify(resource))
  return create(parser_pb.CellSchema, {
    kind: parser_pb.CellKind.CODE,
    languageId: LINKED_RESOURCE_LANGUAGE_ID,
    value: JSON.stringify(normalized, null, 2),
    metadata: {
      [LINKED_RESOURCE_METADATA_KEY]: 'true',
      [LINKED_RESOURCE_VERSION_METADATA_KEY]: '1',
    },
  })
}

export function linkedResourceTitle(resource: LinkedResourceV1): string {
  return (
    resource.presentation.title ||
    resource.hints?.name ||
    (resource.source.provider === 'google-drive'
      ? `Google Drive file ${parseGoogleDriveFileId(resource.source.uri)}`
      : resource.source.uri)
  )
}

export function linkedResourceMarkdown(resource: LinkedResourceV1): string {
  const title = linkedResourceTitle(resource)
    .replace(/\\/g, '\\\\')
    .replace(/\]/g, '\\]')
  return `[${title}](${resource.source.uri})`
}

export function selectLinkedResourceRenderer(
  mimeType: string | undefined,
  requestedMode: LinkedResourcePresentationMode = 'auto'
): LinkedResourceRenderer {
  const normalizedMime = (mimeType ?? '').split(';', 1)[0].trim().toLowerCase()
  if (!normalizedMime) {
    return 'link'
  }
  if (
    normalizedMime.startsWith(GOOGLE_WORKSPACE_MIME_PREFIX) ||
    normalizedMime === 'image/svg+xml' ||
    normalizedMime === 'text/html' ||
    normalizedMime === 'application/javascript' ||
    normalizedMime === 'text/javascript' ||
    normalizedMime === 'application/zip' ||
    normalizedMime === 'application/x-executable'
  ) {
    return 'link'
  }

  const authoritativeMode: LinkedResourceRenderer = SAFE_IMAGE_MIME_TYPES.has(
    normalizedMime
  )
    ? 'image'
    : SAFE_VIDEO_MIME_TYPES.has(normalizedMime)
      ? 'video'
      : SAFE_AUDIO_MIME_TYPES.has(normalizedMime)
        ? 'audio'
        : normalizedMime === 'application/pdf'
          ? 'document'
          : 'link'

  if (requestedMode === 'auto' || requestedMode === 'link') {
    return requestedMode === 'link' ? 'link' : authoritativeMode
  }
  return requestedMode === authoritativeMode ? authoritativeMode : 'link'
}
