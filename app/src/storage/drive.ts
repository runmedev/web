import { create, fromJsonString, toJsonString } from '@bufbuild/protobuf'

import { getGoogleDriveBaseUrl } from '../lib/googleDriveRuntime'
import { IPYNB_MIME_TYPE } from '../lib/ipynb'
import { LinkedResourceError } from '../lib/linkedResource'
import { appLogger } from '../lib/logging/runtime'
import {
  createInitialNotebookFile,
  detectNotebookFileFormat,
} from '../lib/notebookFormat'
import { parser_pb } from '../runme/client'
import {
  type ConflictResult,
  NotebookStoreItem,
  NotebookStoreItemType,
} from './notebook'

const GAPI_SCRIPT_SRC = 'https://apis.google.com/js/api.js'

// VERSION_FIELDS is the fields we want to return when fetching metadata to determine the file content version.
// https://developers.google.com/workspace/drive/api/guides/fields-parameter
const VERSION_FIELDS = 'md5Checksum,headRevisionId,version,appProperties'
const NOTEBOOK_JSON_WRITE_OPTIONS = {
  emitDefaultValues: true,
} as unknown as Parameters<typeof toJsonString>[2]
const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder'
const DRIVE_CREATE_OPERATION_PROPERTY = 'runmeCreateOperationId'
export const DRIVE_CREATE_EXPECTED_CHECKSUM_PROPERTY =
  'runmeCreateExpectedChecksum'
export const DRIVE_CREATE_EXPECTED_REQUEST_PROPERTY =
  'runmeCreateExpectedRequest'
export const DRIVE_CREATE_COMPLETED_CHECKSUM_PROPERTY =
  'runmeCreateCompletedChecksum'

let gapiScriptPromise: Promise<void> | null = null
let clientPromise: Promise<DriveFilesClient> | null = null

// Minimal type definitions that describe just the specific pieces of the global
// gapi client that this module relies on. This keeps the usage of window.gapi
// type-safe without pulling in the full Google typings.
type GapiLoadOptions = {
  callback: () => void
  onerror?: (error: unknown) => void
}

export type DriveDoc = {
  id?: string
  name?: string
  mimeType?: string
  resourceKey?: string
  parents?: string[]
  driveId?: string
  headRevisionId?: string
  content?: string
  trashed?: boolean
  appProperties?: Record<string, string>
}

export type DriveSearchFile = DriveDoc &
  Record<string, unknown> & {
    uri?: string
  }

export type DriveSearchResult = {
  files: DriveSearchFile[]
  nextPageToken?: string
  incompleteSearch?: boolean
}

export type BinaryBody = Blob | ArrayBuffer | Uint8Array

export type DriveResourceMetadata = {
  uri: string
  name: string
  mimeType: string
  sizeBytes?: number
  modifiedTime?: string
  md5Checksum?: string
  headRevisionId?: string
  canDownload: boolean
  webContentLink?: string
  appProperties?: Record<string, string>
  parents?: string[]
}

export type DriveResourceUploadOptions = {
  mimeType: string
  operationId: string
  appProperties?: Record<string, string>
  onProgress?: (uploadedBytes: number, totalBytes: number) => void
  signal?: AbortSignal
}

export type DriveResourceFetchOptions = {
  signal?: AbortSignal
}

const DRIVE_RESOURCE_FIELDS =
  'id,name,mimeType,resourceKey,size,modifiedTime,md5Checksum,headRevisionId,capabilities(canDownload),webContentLink,appProperties,parents'
const DRIVE_ASSET_FOLDER_PROPERTY = 'runmeAssetFolder'
const DRIVE_ASSET_NOTEBOOK_PROPERTY = 'runmeNotebookFileId'
const DRIVE_ASSET_PROPERTY = 'runmeAsset'
const DRIVE_UPLOAD_OPERATION_PROPERTY = 'runmeUploadOperationId'
export const DRIVE_RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024

function driveApiBaseUrl(): string {
  return getGoogleDriveBaseUrl() || 'https://www.googleapis.com'
}

function driveApiUrl(path: string, params?: Record<string, string>): string {
  const url = new URL(path.replace(/^\//, ''), `${driveApiBaseUrl()}/`)
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

function binaryBodyAsBlob(body: BinaryBody, mimeType: string): Blob {
  if (body instanceof Blob) {
    return body.type === mimeType ? body : body.slice(0, body.size, mimeType)
  }
  return new Blob([body], { type: mimeType })
}

function parseDriveSize(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }
  return undefined
}

function normalizeDriveResourceMetadata(
  value: Record<string, unknown>,
  fallbackId?: string
): DriveResourceMetadata {
  const id = optionalString(value.id) ?? fallbackId
  if (!id) {
    throw new LinkedResourceError(
      'PROVIDER_UNAVAILABLE',
      'Google Drive did not return a file identifier'
    )
  }
  const capabilities =
    value.capabilities && typeof value.capabilities === 'object'
      ? (value.capabilities as Record<string, unknown>)
      : {}
  const appProperties =
    value.appProperties && typeof value.appProperties === 'object'
      ? Object.fromEntries(
          Object.entries(value.appProperties as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        )
      : undefined
  const parents = Array.isArray(value.parents)
    ? value.parents.filter(
        (parent): parent is string => typeof parent === 'string'
      )
    : undefined
  return {
    uri: driveFileUrl(id, optionalString(value.resourceKey)),
    name: optionalString(value.name) ?? id,
    mimeType: optionalString(value.mimeType) ?? 'application/octet-stream',
    sizeBytes: parseDriveSize(value.size),
    modifiedTime: optionalString(value.modifiedTime),
    md5Checksum: optionalString(value.md5Checksum),
    headRevisionId: optionalString(value.headRevisionId),
    canDownload: capabilities.canDownload === true,
    webContentLink: optionalString(value.webContentLink),
    appProperties,
    parents,
  }
}

async function driveErrorFromResponse(
  response: Response,
  operation: 'download' | 'upload' | 'metadata'
): Promise<LinkedResourceError> {
  if (response.status === 401) {
    return new LinkedResourceError(
      'AUTH_REQUIRED',
      'Google Drive authorization is required'
    )
  }
  if (response.status === 403) {
    const responseText = await response.text().catch(() => '')
    const serviceAccountMessage = serviceAccountStorageQuotaErrorMessage(
      new DriveRequestError(responseText, response.status)
    )
    return new LinkedResourceError(
      operation === 'download' ? 'DOWNLOAD_RESTRICTED' : 'ACCESS_DENIED',
      serviceAccountMessage ?? `Google Drive denied ${operation} access`
    )
  }
  if (response.status === 404) {
    return new LinkedResourceError('NOT_FOUND', 'Google Drive file not found')
  }
  return new LinkedResourceError(
    'PROVIDER_UNAVAILABLE',
    `Google Drive ${operation} failed (${response.status})`
  )
}

type Drive = {
  id?: string
  name?: string
}

type GapiDriveFileMethods = {
  create: (request: Record<string, unknown>) => Promise<unknown>
  update: (request: Record<string, unknown>) => Promise<unknown>
  get: (request: Record<string, unknown>) => Promise<unknown>
  list: (request: Record<string, unknown>) => Promise<unknown>
}

type GapiDriveMethods = {
  get: (request: Record<string, unknown>) => Promise<unknown>
}

type GapiDriveRevisionMethods = {
  get: (request: Record<string, unknown>) => Promise<unknown>
  list: (request: Record<string, unknown>) => Promise<unknown>
}

type GapiRequestArgs = {
  path: string
  method?: string
  params?: Record<string, string>
  headers?: Record<string, string>
  body?: string | ArrayBuffer
}

interface GapiGlobal {
  load: (name: string, options: GapiLoadOptions) => void
  client: {
    load: (name: string, version: string) => Promise<void>
    setToken: (token: { access_token: string } | null) => void
    getToken?: () => { access_token?: string } | null
    drive: {
      files: GapiDriveFileMethods
      drives: GapiDriveMethods
      revisions: GapiDriveRevisionMethods
    }
    request: (args: GapiRequestArgs) => Promise<unknown>
  }
}

type DriveCreateResponse = { result?: DriveDoc }
type DriveUpdateResponse = { result?: DriveDoc }
type DriveGetResponse = { result?: Drive }
type DriveListResponse = {
  result?: {
    files?: DriveSearchFile[]
    nextPageToken?: string
    incompleteSearch?: boolean
  }
}
type DriveRevisionListResponse = {
  result?: { revisions?: DriveRevision[]; nextPageToken?: string }
}

interface DriveFilesClient {
  generateFileId(): Promise<string>
  create(
    doc: DriveDoc,
    resourceKeyHeaders?: Record<string, string>
  ): Promise<DriveDoc>
  update(doc: DriveDoc): Promise<DriveDoc>
  move(
    fileId: string,
    sourceParentId: string,
    destinationParentId: string,
    resourceKey?: string,
    resourceKeyHeaders?: Record<string, string>
  ): Promise<DriveDoc>
  get(
    request: Record<string, unknown>
  ): Promise<{ body?: string; result?: unknown }>
  getVersionMetadataWithEtag(
    fileId: string,
    resourceKey?: string
  ): Promise<{
    metadata: DriveVersionMetadata | null
    etag?: string
  }>
  setContentIfMatch(
    fileId: string,
    content: string,
    mimeType: string,
    etag: string,
    resourceKey?: string
  ): Promise<boolean>
  getDrive(request: Record<string, unknown>): Promise<DriveGetResponse>
  list(
    request: Record<string, unknown>,
    headers?: Record<string, string>
  ): Promise<DriveListResponse>
  listRevisions(
    request: Record<string, unknown>,
    headers?: Record<string, string>
  ): Promise<DriveRevisionListResponse>
  getRevision(
    request: Record<string, unknown>,
    headers?: Record<string, string>
  ): Promise<{ body?: string; result?: unknown }>
  listComments(
    request: Record<string, unknown>,
    headers?: Record<string, string>
  ): Promise<DriveCommentListResponse>
  createComment(request: {
    fileId: string
    resource: Record<string, unknown>
    fields?: string
    headers?: Record<string, string>
  }): Promise<{ result?: unknown }>
  updateComment(request: {
    fileId: string
    commentId: string
    resource: Record<string, unknown>
    fields?: string
    headers?: Record<string, string>
  }): Promise<{ result?: unknown }>
  createReply(request: {
    fileId: string
    commentId: string
    resource: Record<string, unknown>
    fields?: string
    headers?: Record<string, string>
  }): Promise<{ result?: unknown }>
  ensureParent(
    file: DriveDoc,
    parentId?: string,
    resourceKeyHeaders?: Record<string, string>
  ): Promise<DriveDoc>
}

class DrivePreconditionFailedError extends Error {}

class DriveRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

export class DriveCreateNotCommittedError extends Error {
  readonly cause: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.cause = cause
  }
}

export class DriveFileCreatedError extends Error {
  constructor(
    readonly fileId: string,
    readonly fileName: string | undefined,
    readonly cause?: unknown,
    readonly creationRevisionId?: string
  ) {
    super(`Google Drive file ${fileId} was created before its upload failed`)
  }
}

function driveErrorStatus(error: unknown): number | undefined {
  if (error instanceof DriveRequestError) {
    return error.status
  }
  if (!error || typeof error !== 'object') {
    return undefined
  }
  const candidate = error as {
    status?: unknown
    result?: { error?: { code?: unknown } }
  }
  const status = candidate.status ?? candidate.result?.error?.code
  return typeof status === 'number' ? status : undefined
}

function driveErrorText(error: unknown): string {
  const messages: string[] = []
  if (error instanceof Error && error.message) {
    messages.push(error.message)
  }
  if (error && typeof error === 'object') {
    const candidate = error as {
      body?: unknown
      message?: unknown
      result?: {
        error?: {
          message?: unknown
          errors?: Array<{ message?: unknown; reason?: unknown }>
        }
      }
    }
    if (typeof candidate.message === 'string') {
      messages.push(candidate.message)
    }
    if (typeof candidate.body === 'string') {
      messages.push(candidate.body)
    }
    const resultError = candidate.result?.error
    if (typeof resultError?.message === 'string') {
      messages.push(resultError.message)
    }
    for (const detail of resultError?.errors ?? []) {
      if (typeof detail.reason === 'string') {
        messages.push(detail.reason)
      }
      if (typeof detail.message === 'string') {
        messages.push(detail.message)
      }
    }
  }
  return messages.join(' ')
}

function serviceAccountStorageQuotaErrorMessage(
  error: unknown
): string | undefined {
  const errorText = driveErrorText(error).toLowerCase()
  const isStorageQuotaError =
    errorText.includes('storagequotaexceeded') ||
    errorText.includes('storage quota')
  if (!isStorageQuotaError || !errorText.includes('service account')) {
    return undefined
  }
  return (
    'Google Drive cannot create this file because service accounts do not ' +
    "have storage quota and cannot own files in a user's My Drive. Choose " +
    'a folder in a Shared drive, add the service account as a Contributor ' +
    '(or Content manager for move and delete operations), and try again. ' +
    "A folder shared from a user's My Drive is not a Shared drive. " +
    'Alternatively, authenticate as a human user.'
  )
}

async function createDriveItem(
  client: DriveFilesClient,
  doc: DriveDoc,
  resourceKeyHeaders: Record<string, string> = {}
): Promise<DriveDoc> {
  try {
    return await client.create(doc, resourceKeyHeaders)
  } catch (error) {
    const message = serviceAccountStorageQuotaErrorMessage(error)
    if (message) {
      throw new DriveCreateNotCommittedError(message, error)
    }
    throw error
  }
}

function isDefinitelyRejectedCreate(error: unknown): boolean {
  const status = driveErrorStatus(error)
  return status !== undefined && status >= 400 && status < 500 && status !== 408
}

export type DriveUser = {
  displayName?: string
  photoLink?: string
  me?: boolean
}

export type DriveReply = {
  id?: string
  kind?: string
  createdTime?: string
  modifiedTime?: string
  action?: string
  author?: DriveUser
  deleted?: boolean
  htmlContent?: string
  content?: string
  runmeSyncStatus?: 'pending' | 'syncing' | 'uncertain' | 'failed'
  runmeSyncError?: string
  runmeOperationId?: string
}

export type DriveComment = {
  id?: string
  kind?: string
  createdTime?: string
  modifiedTime?: string
  resolved?: boolean
  anchor?: string
  author?: DriveUser
  deleted?: boolean
  htmlContent?: string
  content?: string
  quotedFileContent?: {
    mimeType?: string
    value?: string
  }
  mentionedEmailAddresses?: string[]
  assigneeEmailAddress?: string
  replies?: DriveReply[]
  runmeSyncStatus?: 'pending' | 'syncing' | 'uncertain' | 'failed'
  runmeSyncError?: string
  runmeOperationId?: string
}

type DriveCommentListResponse = {
  result?: {
    comments?: DriveComment[]
    nextPageToken?: string
  }
}

const DRIVE_COMMENT_FIELDS =
  'id,createdTime,modifiedTime,resolved,anchor,author(displayName,photoLink,me),deleted,htmlContent,content,quotedFileContent(mimeType,value),replies(id,createdTime,modifiedTime,action,author(displayName,photoLink,me),deleted,htmlContent,content)'
const DRIVE_COMMENT_LIST_FIELDS = `nextPageToken,comments(${DRIVE_COMMENT_FIELDS})`

class GapiDriveFilesClient implements DriveFilesClient {
  private readonly files: GapiDriveFileMethods
  private readonly drives: GapiDriveMethods
  private readonly revisions: GapiDriveRevisionMethods

  constructor(private readonly gapi: GapiGlobal) {
    this.files = this.gapi.client.drive.files
    this.drives = this.gapi.client.drive.drives
    this.revisions = this.gapi.client.drive.revisions
  }

  private buildUrl(path: string, params?: Record<string, unknown>): string {
    const url = new URL(path.replace(/^\//, ''), 'https://www.googleapis.com/')
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined || value === null || value === '') {
        continue
      }
      url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  private async request(
    method: string,
    path: string,
    options: {
      params?: Record<string, unknown>
      body?: string
      contentType?: string
      expectText?: boolean
      headers?: Record<string, string>
    } = {}
  ): Promise<{ body?: string; result?: unknown; etag?: string }> {
    const token = this.gapi.client.getToken?.()?.access_token ?? ''
    if (!token) {
      throw new Error('Google Drive request requires an access token')
    }
    const response = await fetch(this.buildUrl(path, options.params), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...options.headers,
        ...(options.body !== undefined
          ? {
              'Content-Type': options.contentType ?? 'application/json',
            }
          : {}),
      },
      body: options.body,
    })

    if (response.status === 412) {
      throw new DrivePreconditionFailedError(
        'Google Drive write precondition failed'
      )
    }
    if (!response.ok) {
      const errorBody = await response.text().catch(() => '')
      throw new DriveRequestError(
        `Drive request failed (${response.status} ${response.statusText}): ${errorBody}`,
        response.status
      )
    }

    if (options.expectText) {
      return {
        body: await response.text(),
        etag: response.headers.get('etag') ?? undefined,
      }
    }

    const text = await response.text()
    if (!text) {
      return {
        result: undefined,
        etag: response.headers.get('etag') ?? undefined,
      }
    }
    return {
      result: JSON.parse(text),
      etag: response.headers.get('etag') ?? undefined,
    }
  }

  private getUtf8Media(
    path: string,
    request: Record<string, unknown>
  ): Promise<{ body?: string; result?: unknown }> {
    const params = { ...request }
    delete params.fileId
    delete params.revisionId

    // GAPI decodes media response bytes as Latin-1. Fetch's Response.text()
    // decodes them as UTF-8, preserving emoji and other non-ASCII text.
    return this.request('GET', path, { params, expectText: true })
  }

  // setContent uploads content to a Google Drive file using a media upload.
  // https://content.googleapis.com/upload/drive/v3/files/19uA730OLadqxfEUgUHN35YAQDAt2Pcax?uploadType=media&alt=json
  // It looks like gapi unlike node clients don't have helper methods for media uploads
  // so we have to do it manually.
  //
  // The API reference says you can update media and metadata in a single request but I couldn't quite
  // figure it out so it seemed easier to just use two requests; one which updates metadata (name, mimeType)
  // and another which uploads the content.
  private async setContent(
    fileId: string,
    content: string,
    mimeType?: string,
    resourceKey?: string
  ): Promise<void> {
    const token = this.gapi.client.getToken?.()?.access_token ?? ''
    if (!token) {
      throw new Error('Google Drive upload requires an access token')
    }
    const url = new URL(
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}`
    )
    url.searchParams.set('uploadType', 'media')
    url.searchParams.set('supportsAllDrives', 'true')
    if (resourceKey) {
      url.searchParams.set('resourceKey', resourceKey)
    }
    const response = await fetch(url.toString(), {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': mimeType ?? 'application/octet-stream',
      },
      body: content,
    })
    if (!response.ok) {
      const message = await response.text().catch(() => '')
      throw new Error(
        `Google Drive media upload failed (${response.status}): ${message}`
      )
    }
  }

  private buildResource(
    doc: DriveDoc,
    includeId = false
  ): Record<string, unknown> {
    const resource: Record<string, unknown> = {}
    if (includeId && typeof doc.id === 'string') {
      resource.id = doc.id
    }
    if (typeof doc.name === 'string') {
      resource.name = doc.name
    }
    if (typeof doc.mimeType === 'string') {
      resource.mimeType = doc.mimeType
    }
    if (Array.isArray(doc.parents)) {
      resource.parents = doc.parents
    }
    if (typeof doc.trashed === 'boolean') {
      resource.trashed = doc.trashed
    }
    if (doc.appProperties) {
      resource.appProperties = doc.appProperties
    }
    return resource
  }

  async generateFileId(): Promise<string> {
    const response = await this.request('GET', '/drive/v3/files/generateIds', {
      params: { count: 1, space: 'drive', type: 'files' },
    })
    const id = (response.result as { ids?: unknown } | undefined)?.ids
    if (!Array.isArray(id) || typeof id[0] !== 'string' || !id[0]) {
      throw new Error('Google Drive did not return a generated file id')
    }
    return id[0]
  }

  async create(
    doc: DriveDoc,
    resourceKeyHeaders: Record<string, string> = {}
  ): Promise<DriveDoc> {
    const resource = this.buildResource(doc, true)
    const fields =
      doc.content === undefined
        ? 'id,name,mimeType,parents'
        : 'id,name,mimeType,parents,headRevisionId'
    const response =
      Object.keys(resourceKeyHeaders).length > 0
        ? ((await this.request('POST', '/drive/v3/files', {
            params: { fields, supportsAllDrives: true },
            body: JSON.stringify(resource),
            headers: resourceKeyHeaders,
          })) as DriveCreateResponse)
        : ((await this.files.create({
            resource,
            fields,
            supportsAllDrives: true,
          } as Record<string, unknown>)) as DriveCreateResponse)
    const file = response.result ?? {}
    if (file.id && doc.content !== undefined) {
      console.log(`Setting content for new Drive file ${file.id}`)
      try {
        await this.setContent(file.id, doc.content, doc.mimeType)
      } catch (error) {
        throw new DriveFileCreatedError(
          file.id,
          file.name,
          error,
          file.headRevisionId
        )
      }
    }
    return file
  }

  async update(doc: DriveDoc): Promise<DriveDoc> {
    if (!doc.id) {
      throw new Error('Drive file id is required for update')
    }
    const resource = this.buildResource(doc)
    let file: DriveDoc = { id: doc.id }
    if (Object.keys(resource).length > 0) {
      const response = (await this.files.update({
        fileId: doc.id,
        resource,
        fields: 'id,name,mimeType,parents',
        supportsAllDrives: true,
        resourceKey: doc.resourceKey,
      } as Record<string, unknown>)) as DriveUpdateResponse
      file = response.result ?? { id: doc.id }
    } else {
      file = {
        id: doc.id,
        name: doc.name,
        mimeType: doc.mimeType,
        parents: doc.parents,
      }
    }

    if (doc.content !== undefined && file.id) {
      await this.setContent(
        file.id,
        doc.content,
        doc.mimeType,
        doc.resourceKey
      )
    }

    return file
  }

  async move(
    fileId: string,
    sourceParentId: string,
    destinationParentId: string,
    resourceKey?: string,
    resourceKeyHeaders: Record<string, string> = {}
  ): Promise<DriveDoc> {
    const params = {
      addParents: destinationParentId,
      removeParents: sourceParentId,
      supportsAllDrives: true,
      fields: 'id,name,mimeType,parents',
      resourceKey,
    }
    const response =
      Object.keys(resourceKeyHeaders).length > 0
        ? ((await this.request(
            'PATCH',
            `/drive/v3/files/${encodeURIComponent(fileId)}`,
            { params, headers: resourceKeyHeaders }
          )) as DriveUpdateResponse)
        : ((await this.files.update({
            fileId,
            ...params,
          } as Record<string, unknown>)) as DriveUpdateResponse)
    return response.result ?? { id: fileId }
  }

  get(
    request: Record<string, unknown>
  ): Promise<{ body?: string; result?: unknown }> {
    if (request.alt === 'media') {
      const fileId = String(request.fileId ?? '')
      return this.getUtf8Media(
        `/drive/v3/files/${encodeURIComponent(fileId)}`,
        request
      )
    }
    return this.files.get(request as any) as Promise<{
      body?: string
      result?: unknown
    }>
  }

  async getVersionMetadataWithEtag(
    fileId: string,
    resourceKey?: string
  ): Promise<{
    metadata: DriveVersionMetadata | null
    etag?: string
  }> {
    const response = await this.request(
      'GET',
      `/drive/v3/files/${encodeURIComponent(fileId)}`,
      {
        params: {
          supportsAllDrives: true,
          fields: VERSION_FIELDS,
          resourceKey,
        },
      }
    )
    return {
      metadata: (response.result as DriveVersionMetadata | undefined) ?? null,
      etag: response.etag,
    }
  }

  async setContentIfMatch(
    fileId: string,
    content: string,
    mimeType: string,
    etag: string,
    resourceKey?: string
  ): Promise<boolean> {
    try {
      await this.request(
        'PATCH',
        `/upload/drive/v3/files/${encodeURIComponent(fileId)}`,
        {
          params: {
            uploadType: 'media',
            supportsAllDrives: true,
            resourceKey,
          },
          body: content,
          contentType: mimeType,
          headers: { 'If-Match': etag },
        }
      )
      return true
    } catch (error) {
      if (error instanceof DrivePreconditionFailedError) {
        return false
      }
      throw error
    }
  }

  list(
    request: Record<string, unknown>,
    headers: Record<string, string> = {}
  ): Promise<DriveListResponse> {
    if (Object.keys(headers).length > 0) {
      return this.request('GET', '/drive/v3/files', {
        params: request,
        headers,
      }) as Promise<DriveListResponse>
    }
    return this.files.list(request as any) as Promise<DriveListResponse>
  }

  getDrive(request: Record<string, unknown>): Promise<DriveGetResponse> {
    return this.drives.get(request as any) as Promise<DriveGetResponse>
  }

  listRevisions(
    request: Record<string, unknown>,
    headers: Record<string, string> = {}
  ): Promise<DriveRevisionListResponse> {
    if (Object.keys(headers).length > 0) {
      const fileId = String(request.fileId ?? '')
      const params = { ...request }
      delete params.fileId
      return this.request(
        'GET',
        `/drive/v3/files/${encodeURIComponent(fileId)}/revisions`,
        { params, headers }
      ) as Promise<DriveRevisionListResponse>
    }
    return this.revisions.list(
      request as any
    ) as Promise<DriveRevisionListResponse>
  }

  getRevision(
    request: Record<string, unknown>,
    headers: Record<string, string> = {}
  ): Promise<{ body?: string; result?: unknown }> {
    if (request.alt === 'media' || Object.keys(headers).length > 0) {
      const fileId = String(request.fileId ?? '')
      const revisionId = String(request.revisionId ?? '')
      const params = { ...request }
      delete params.fileId
      delete params.revisionId
      return this.request(
        'GET',
        `/drive/v3/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}`,
        {
          params,
          expectText: request.alt === 'media',
          headers,
        }
      )
    }
    return this.revisions.get(request as any) as Promise<{
      body?: string
      result?: unknown
    }>
  }

  listComments(
    request: Record<string, unknown>,
    headers: Record<string, string> = {}
  ): Promise<DriveCommentListResponse> {
    const fileId = String(request.fileId ?? '')
    const params = { ...request }
    delete params.fileId
    return this.request(
      'GET',
      `/drive/v3/files/${encodeURIComponent(fileId)}/comments`,
      { params, headers }
    ) as Promise<DriveCommentListResponse>
  }

  createComment(request: {
    fileId: string
    resource: Record<string, unknown>
    fields?: string
    headers?: Record<string, string>
  }): Promise<{ result?: unknown }> {
    return this.request(
      'POST',
      `/drive/v3/files/${encodeURIComponent(request.fileId)}/comments`,
      {
        params: {
          fields: request.fields ?? DRIVE_COMMENT_FIELDS,
          supportsAllDrives: 'true',
        },
        body: JSON.stringify(request.resource),
        headers: request.headers,
      }
    )
  }

  updateComment(request: {
    fileId: string
    commentId: string
    resource: Record<string, unknown>
    fields?: string
    headers?: Record<string, string>
  }): Promise<{ result?: unknown }> {
    return this.request(
      'PATCH',
      `/drive/v3/files/${encodeURIComponent(request.fileId)}/comments/${encodeURIComponent(request.commentId)}`,
      {
        params: {
          fields: request.fields ?? DRIVE_COMMENT_FIELDS,
          supportsAllDrives: 'true',
        },
        body: JSON.stringify(request.resource),
        headers: request.headers,
      }
    )
  }

  createReply(request: {
    fileId: string
    commentId: string
    resource: Record<string, unknown>
    fields?: string
    headers?: Record<string, string>
  }): Promise<{ result?: unknown }> {
    return this.request(
      'POST',
      `/drive/v3/files/${encodeURIComponent(request.fileId)}/comments/${encodeURIComponent(request.commentId)}/replies`,
      {
        params: {
          fields:
            request.fields ??
            `id,action,createdTime,modifiedTime,author(displayName,photoLink,me),deleted,htmlContent,content`,
          supportsAllDrives: 'true',
        },
        body: JSON.stringify(request.resource),
        headers: request.headers,
      }
    )
  }

  async ensureParent(
    file: DriveDoc,
    parentId?: string,
    resourceKeyHeaders: Record<string, string> = {}
  ): Promise<DriveDoc> {
    if (!file.id || !parentId) {
      return file
    }
    if ((file.parents ?? []).includes(parentId)) {
      return file
    }
    const request: Record<string, unknown> = {
      fileId: file.id,
      addParents: parentId,
      supportsAllDrives: true,
      fields: 'id,name,mimeType,parents',
    }
    if ((file.parents ?? []).includes('root')) {
      request.removeParents = 'root'
    }
    const rawParams = { ...request }
    delete rawParams.fileId
    const response =
      Object.keys(resourceKeyHeaders).length > 0
        ? ((await this.request(
            'PATCH',
            `/drive/v3/files/${encodeURIComponent(file.id)}`,
            { params: rawParams, headers: resourceKeyHeaders }
          )) as DriveUpdateResponse)
        : ((await this.files.update(request)) as DriveUpdateResponse)
    return response.result ?? file
  }
}

class FetchDriveFilesClient implements DriveFilesClient {
  constructor(
    private readonly baseUrl: string,
    private readonly accessToken: string
  ) {}

  private buildUrl(path: string, params?: Record<string, unknown>): string {
    const url = new URL(path.replace(/^\//, ''), `${this.baseUrl}/`)
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined || value === null || value === '') {
        continue
      }
      url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  private async request(
    method: string,
    path: string,
    options: {
      params?: Record<string, unknown>
      body?: string
      contentType?: string
      expectText?: boolean
      headers?: Record<string, string>
    } = {}
  ): Promise<{ body?: string; result?: unknown; etag?: string }> {
    const response = await fetch(this.buildUrl(path, options.params), {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        ...options.headers,
        ...(options.body !== undefined
          ? {
              'Content-Type': options.contentType ?? 'application/json',
            }
          : {}),
      },
      body: options.body,
    })

    if (response.status === 412) {
      throw new DrivePreconditionFailedError(
        'Google Drive write precondition failed'
      )
    }
    if (!response.ok) {
      const errorBody = await response.text().catch(() => '')
      throw new DriveRequestError(
        `Drive request failed (${response.status} ${response.statusText}): ${errorBody}`,
        response.status
      )
    }

    if (options.expectText) {
      return {
        body: await response.text(),
        etag: response.headers.get('etag') ?? undefined,
      }
    }

    const text = await response.text()
    if (!text) {
      return {
        result: undefined,
        etag: response.headers.get('etag') ?? undefined,
      }
    }
    return {
      result: JSON.parse(text),
      etag: response.headers.get('etag') ?? undefined,
    }
  }

  private buildResource(
    doc: DriveDoc,
    includeId = false
  ): Record<string, unknown> {
    const resource: Record<string, unknown> = {}
    if (includeId && typeof doc.id === 'string') {
      resource.id = doc.id
    }
    if (typeof doc.name === 'string') {
      resource.name = doc.name
    }
    if (typeof doc.mimeType === 'string') {
      resource.mimeType = doc.mimeType
    }
    if (Array.isArray(doc.parents)) {
      resource.parents = doc.parents
    }
    if (typeof doc.trashed === 'boolean') {
      resource.trashed = doc.trashed
    }
    if (doc.appProperties) {
      resource.appProperties = doc.appProperties
    }
    return resource
  }

  async generateFileId(): Promise<string> {
    const response = await this.request('GET', '/drive/v3/files/generateIds', {
      params: { count: 1, space: 'drive', type: 'files' },
    })
    const ids = (response.result as { ids?: unknown } | undefined)?.ids
    if (!Array.isArray(ids) || typeof ids[0] !== 'string' || !ids[0]) {
      throw new Error('Google Drive did not return a generated file id')
    }
    return ids[0]
  }

  private async setContent(
    fileId: string,
    content: string,
    mimeType?: string,
    resourceKey?: string
  ): Promise<void> {
    await this.request(
      'PATCH',
      `/upload/drive/v3/files/${encodeURIComponent(fileId)}`,
      {
        params: {
          uploadType: 'media',
          supportsAllDrives: 'true',
          resourceKey,
        },
        body: content,
        contentType: mimeType ?? 'application/octet-stream',
      }
    )
  }

  async create(
    doc: DriveDoc,
    resourceKeyHeaders: Record<string, string> = {}
  ): Promise<DriveDoc> {
    const response = await this.request('POST', '/drive/v3/files', {
      params: {
        fields:
          doc.content === undefined
            ? 'id,name,mimeType,parents'
            : 'id,name,mimeType,parents,headRevisionId',
        supportsAllDrives: 'true',
      },
      body: JSON.stringify(this.buildResource(doc, true)),
      headers: resourceKeyHeaders,
    })
    const file = (response.result ?? {}) as DriveDoc
    if (file.id && doc.content !== undefined) {
      try {
        await this.setContent(file.id, doc.content, doc.mimeType)
      } catch (error) {
        throw new DriveFileCreatedError(
          file.id,
          file.name,
          error,
          file.headRevisionId
        )
      }
    }
    return file
  }

  async update(doc: DriveDoc): Promise<DriveDoc> {
    if (!doc.id) {
      throw new Error('Drive file id is required for update')
    }
    const resource = this.buildResource(doc)
    let file: DriveDoc = { id: doc.id }
    if (Object.keys(resource).length > 0) {
      const response = await this.request(
        'PATCH',
        `/drive/v3/files/${encodeURIComponent(doc.id)}`,
        {
          params: {
            fields: 'id,name,mimeType,parents',
            supportsAllDrives: 'true',
            resourceKey: doc.resourceKey,
          },
          body: JSON.stringify(resource),
        }
      )
      file = (response.result ?? {}) as DriveDoc
    }

    if (doc.content !== undefined) {
      await this.setContent(
        doc.id,
        doc.content,
        doc.mimeType,
        doc.resourceKey
      )
    }

    return file.id ? file : { ...doc }
  }

  async move(
    fileId: string,
    sourceParentId: string,
    destinationParentId: string,
    resourceKey?: string,
    resourceKeyHeaders: Record<string, string> = {}
  ): Promise<DriveDoc> {
    const response = await this.request(
      'PATCH',
      `/drive/v3/files/${encodeURIComponent(fileId)}`,
      {
        params: {
          addParents: destinationParentId,
          removeParents: sourceParentId,
          supportsAllDrives: 'true',
          fields: 'id,name,mimeType,parents',
          resourceKey,
        },
        headers: resourceKeyHeaders,
      }
    )
    return (response.result ?? { id: fileId }) as DriveDoc
  }

  get(
    request: Record<string, unknown>
  ): Promise<{ body?: string; result?: unknown }> {
    const fileId = String(request.fileId ?? '')
    return this.request(
      'GET',
      `/drive/v3/files/${encodeURIComponent(fileId)}`,
      {
        params: request,
        expectText: request.alt === 'media',
      }
    )
  }

  async getVersionMetadataWithEtag(
    fileId: string,
    resourceKey?: string
  ): Promise<{
    metadata: DriveVersionMetadata | null
    etag?: string
  }> {
    const response = await this.request(
      'GET',
      `/drive/v3/files/${encodeURIComponent(fileId)}`,
      {
        params: {
          supportsAllDrives: true,
          fields: VERSION_FIELDS,
          resourceKey,
        },
      }
    )
    return {
      metadata: (response.result as DriveVersionMetadata | undefined) ?? null,
      etag: response.etag,
    }
  }

  async setContentIfMatch(
    fileId: string,
    content: string,
    mimeType: string,
    etag: string,
    resourceKey?: string
  ): Promise<boolean> {
    try {
      await this.request(
        'PATCH',
        `/upload/drive/v3/files/${encodeURIComponent(fileId)}`,
        {
          params: {
            uploadType: 'media',
            supportsAllDrives: true,
            resourceKey,
          },
          body: content,
          contentType: mimeType,
          headers: { 'If-Match': etag },
        }
      )
      return true
    } catch (error) {
      if (error instanceof DrivePreconditionFailedError) {
        return false
      }
      throw error
    }
  }

  list(
    request: Record<string, unknown>,
    headers: Record<string, string> = {}
  ): Promise<DriveListResponse> {
    return this.request('GET', '/drive/v3/files', {
      params: request,
      headers,
    }) as Promise<DriveListResponse>
  }

  getDrive(request: Record<string, unknown>): Promise<DriveGetResponse> {
    const driveId = String(request.driveId ?? '')
    return this.request(
      'GET',
      `/drive/v3/drives/${encodeURIComponent(driveId)}`,
      { params: request }
    ) as Promise<DriveGetResponse>
  }

  listRevisions(
    request: Record<string, unknown>,
    headers: Record<string, string> = {}
  ): Promise<DriveRevisionListResponse> {
    const fileId = String(request.fileId ?? '')
    return this.request(
      'GET',
      `/drive/v3/files/${encodeURIComponent(fileId)}/revisions`,
      { params: request, headers }
    ) as Promise<DriveRevisionListResponse>
  }

  getRevision(
    request: Record<string, unknown>,
    headers: Record<string, string> = {}
  ): Promise<{ body?: string; result?: unknown }> {
    const fileId = String(request.fileId ?? '')
    const revisionId = String(request.revisionId ?? '')
    return this.request(
      'GET',
      `/drive/v3/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}`,
      {
        params: request,
        expectText: request.alt === 'media',
        headers,
      }
    )
  }

  listComments(
    request: Record<string, unknown>,
    headers: Record<string, string> = {}
  ): Promise<DriveCommentListResponse> {
    const fileId = String(request.fileId ?? '')
    const params = { ...request }
    delete params.fileId
    return this.request(
      'GET',
      `/drive/v3/files/${encodeURIComponent(fileId)}/comments`,
      { params, headers }
    ) as Promise<DriveCommentListResponse>
  }

  createComment(request: {
    fileId: string
    resource: Record<string, unknown>
    fields?: string
    headers?: Record<string, string>
  }): Promise<{ result?: unknown }> {
    return this.request(
      'POST',
      `/drive/v3/files/${encodeURIComponent(request.fileId)}/comments`,
      {
        params: {
          fields: request.fields ?? DRIVE_COMMENT_FIELDS,
          supportsAllDrives: 'true',
        },
        body: JSON.stringify(request.resource),
        headers: request.headers,
      }
    )
  }

  updateComment(request: {
    fileId: string
    commentId: string
    resource: Record<string, unknown>
    fields?: string
    headers?: Record<string, string>
  }): Promise<{ result?: unknown }> {
    return this.request(
      'PATCH',
      `/drive/v3/files/${encodeURIComponent(request.fileId)}/comments/${encodeURIComponent(request.commentId)}`,
      {
        params: {
          fields: request.fields ?? DRIVE_COMMENT_FIELDS,
          supportsAllDrives: 'true',
        },
        body: JSON.stringify(request.resource),
        headers: request.headers,
      }
    )
  }

  createReply(request: {
    fileId: string
    commentId: string
    resource: Record<string, unknown>
    fields?: string
    headers?: Record<string, string>
  }): Promise<{ result?: unknown }> {
    return this.request(
      'POST',
      `/drive/v3/files/${encodeURIComponent(request.fileId)}/comments/${encodeURIComponent(request.commentId)}/replies`,
      {
        params: {
          fields:
            request.fields ??
            'id,action,createdTime,modifiedTime,author(displayName,photoLink,me),deleted,htmlContent,content',
          supportsAllDrives: 'true',
        },
        body: JSON.stringify(request.resource),
        headers: request.headers,
      }
    )
  }

  async ensureParent(
    file: DriveDoc,
    parentId?: string,
    resourceKeyHeaders: Record<string, string> = {}
  ): Promise<DriveDoc> {
    if (!file.id || !parentId) {
      return file
    }
    if ((file.parents ?? []).includes(parentId)) {
      return file
    }

    const response = await this.request(
      'PATCH',
      `/drive/v3/files/${encodeURIComponent(file.id)}`,
      {
        params: {
          addParents: parentId,
          supportsAllDrives: 'true',
          fields: 'id,name,mimeType,parents',
          ...((file.parents ?? []).includes('root')
            ? { removeParents: 'root' }
            : {}),
        },
        headers: resourceKeyHeaders,
      }
    )

    return (response.result ?? file) as DriveDoc
  }
}

// Augment the browser Window type so TypeScript knows that the Google API
// script may attach a gapi object at runtime. This lets the rest of the module
// access window.gapi without falling back to any-typed shims.
declare global {
  interface Window {
    gapi?: GapiGlobal
  }
}

function loadGapiScript(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(
      new Error('Google APIs are only available in a browser environment')
    )
  }

  if (window.gapi?.load) {
    return Promise.resolve()
  }

  if (!gapiScriptPromise) {
    gapiScriptPromise = new Promise<void>((resolve, reject) => {
      const existingScript = document.querySelector<HTMLScriptElement>(
        `script[src="${GAPI_SCRIPT_SRC}"]`
      )

      if (existingScript) {
        existingScript.addEventListener('load', () => resolve(), {
          once: true,
        })
        existingScript.addEventListener('error', reject, { once: true })
        return
      }

      const script = document.createElement('script')
      script.src = GAPI_SCRIPT_SRC
      script.async = true
      script.defer = true
      script.onload = () => resolve()
      script.onerror = reject
      document.head.appendChild(script)
    })
  }

  return gapiScriptPromise.then(() => {
    if (!window.gapi?.load) {
      throw new Error('Google API script loaded but gapi is unavailable')
    }
  })
}

async function ensureGapi(): Promise<typeof window.gapi> {
  if (typeof window === 'undefined') {
    throw new Error('Google APIs are only available in a browser environment')
  }

  if (!window.gapi?.load) {
    await loadGapiScript()
  }

  if (!window.gapi?.load) {
    throw new Error('Google API script failed to initialize gapi')
  }

  return window.gapi
}

// ensureDriveFilesClient creates a gapi client for the Google Drive Files API
// by loading the discovery document for the Drive API v3.
// it is parameterized by the accessToken.
//
// TODO(jlewi): Does it make sense to take the accessToken as a parameter?
// This seems like it means we need to recreate the client every time the token expires.
// The more common pattern seems to be to have the client take a reference to a class/function
// which can be called to get get a token and which handles refreshing the token as needed.
async function ensureDriveFilesClient(
  accessToken: string
): Promise<DriveFilesClient> {
  const baseUrl = getGoogleDriveBaseUrl()
  if (baseUrl) {
    return new FetchDriveFilesClient(baseUrl, accessToken)
  }

  const gapi = await ensureGapi()
  if (!gapi) {
    throw new Error('Google API client is unavailable')
  }

  if (!clientPromise) {
    clientPromise = new Promise<DriveFilesClient>((resolve, reject) => {
      gapi.load('client', {
        callback: async () => {
          try {
            await gapi.client.load('drive', 'v3')
            resolve(new GapiDriveFilesClient(gapi))
          } catch (error) {
            reject(error)
          }
        },
        onerror: (error: unknown) => reject(error),
      })
    }).catch((error) => {
      clientPromise = null
      throw error
    })
  }

  const pendingClient = clientPromise
  if (!pendingClient) {
    throw new Error('Google Drive client initialization failed')
  }
  const client = await pendingClient
  gapi.client.setToken({ access_token: accessToken })
  return client
}

function validateDriveId(id: string | null | undefined): string {
  if (!id) {
    throw new Error('Google Drive URI is missing a file identifier')
  }
  const trimmed = id.trim()
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error(
      `Google Drive identifier contains invalid characters: ${id}`
    )
  }
  return trimmed
}

/** Returns a canonical Drive file URL, preserving a required resource key. */
export function driveFileUrl(id: string, resourceKey?: string): string {
  const url = new URL(
    `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`
  )
  if (resourceKey) {
    url.searchParams.set('resourcekey', resourceKey)
  }
  return url.toString()
}

/** Returns a canonical Drive folder URL, preserving a required resource key. */
export function driveFolderUrl(id: string, resourceKey?: string): string {
  const url = new URL(
    `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`
  )
  if (resourceKey) {
    url.searchParams.set('resourcekey', resourceKey)
  }
  return url.toString()
}

export interface DriveItem {
  id: string
  type: NotebookStoreItemType
  resourceKey?: string
}

/** Creates the Drive header required to dereference resource-key URLs. */
function driveResourceKeysHeaders(
  items: Array<Pick<DriveItem, 'id' | 'resourceKey'>>
): Record<string, string> {
  const keyedItems = new Map<string, string>()
  for (const item of items) {
    if (!item.resourceKey) {
      continue
    }
    if (!/^[A-Za-z0-9_-]+$/.test(item.resourceKey)) {
      throw new Error('Google Drive resource key contains invalid characters')
    }
    keyedItems.set(item.id, item.resourceKey)
  }
  if (keyedItems.size === 0) {
    return {}
  }
  return {
    'X-Goog-Drive-Resource-Keys': [...keyedItems]
      .map(([id, resourceKey]) => `${id}/${resourceKey}`)
      .join(','),
  }
}

/** Creates the Drive header required to dereference one resource-key URL. */
function driveResourceKeyHeaders(
  item: Pick<DriveItem, 'id' | 'resourceKey'>
): Record<string, string> {
  return driveResourceKeysHeaders([item])
}

type DriveFileMetadata = {
  id?: string
  name?: string
  mimeType?: string
  parents?: string[]
  driveId?: string
  ownedByMe?: boolean
  modifiedTime?: string
  version?: string
  headRevisionId?: string
  md5Checksum?: string
  size?: string
  owners?: DriveIdentity[]
  sharingUser?: DriveIdentity
  lastModifyingUser?: DriveIdentity
  capabilities?: {
    canDownload?: boolean
  }
}

export interface DriveIdentity {
  displayName?: string
  emailAddress?: string
  permissionId?: string
  me?: boolean
}

export interface SharedNotebookPreflight {
  fileId: string
  uri: string
  name: string
  mimeType: string
  parents: NotebookStoreItem[]
  driveId?: string
  ownedByMe?: boolean
  modifiedTime?: string
  version?: string
  headRevisionId?: string
  md5Checksum?: string
  sizeBytes?: number
  owners: DriveIdentity[]
  sharingUser?: DriveIdentity
  lastModifyingUser?: DriveIdentity
  canDownload: boolean
}

export interface DriveVersionMetadata {
  md5Checksum?: string
  headRevisionId?: string
  version?: string
  appProperties?: Record<string, string>
}

export interface DriveRevision {
  id?: string
  mimeType?: string
  modifiedTime?: string
  md5Checksum?: string
  size?: string
  keepForever?: boolean
  lastModifyingUser?: {
    displayName?: string
    emailAddress?: string
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function normalizeDriveRevision(revision: DriveRevision): DriveRevision {
  const lastModifyingUser =
    revision.lastModifyingUser && typeof revision.lastModifyingUser === 'object'
      ? {
          displayName: optionalString(revision.lastModifyingUser.displayName),
          emailAddress: optionalString(revision.lastModifyingUser.emailAddress),
        }
      : undefined

  return {
    id: optionalString(revision.id),
    mimeType: optionalString(revision.mimeType),
    modifiedTime: optionalString(revision.modifiedTime),
    md5Checksum: optionalString(revision.md5Checksum),
    size: optionalString(revision.size),
    keepForever:
      typeof revision.keepForever === 'boolean'
        ? revision.keepForever
        : undefined,
    lastModifyingUser,
  }
}

export function parseDriveItem(uri: string): DriveItem {
  if (!uri) {
    throw new Error('Google Drive URI must be provided')
  }

  const trimmed = uri.trim()
  let id: string | undefined
  let type: NotebookStoreItemType = NotebookStoreItemType.File

  try {
    const url = new URL(trimmed)
    const pathname = url.pathname

    if (/\/folders\//.test(pathname)) {
      type = NotebookStoreItemType.Folder
      id = pathname.match(/\/folders\/([^/]+)/)?.[1]
    } else if (/\/file\//.test(pathname) || /\/d\//.test(pathname)) {
      id = pathname.match(/\/d\/([^/]+)/)?.[1]
    }

    if (!id) {
      const queryId = url.searchParams.get('id')
      if (queryId) {
        id = queryId
      }
    }

    if (!id && url.hash) {
      const hashId = url.hash.match(/id=([^&]+)/)?.[1]
      if (hashId) {
        id = hashId
      }
    }

    if (!id) {
      id = pathname.split('/').filter(Boolean).pop()
    }
  } catch {
    // Not a full URL, fall back to raw identifier below.
  }

  if (!id && /^[A-Za-z0-9_-]+$/.test(trimmed)) {
    id = trimmed
  }

  if (!id) {
    throw new Error(
      `Unable to extract a Google Drive identifier from URI: ${uri}`
    )
  }

  id = validateDriveId(id)
  let resourceKey: string | undefined
  try {
    const url = new URL(trimmed)
    resourceKey = url.searchParams.get('resourcekey') ?? undefined
  } catch {
    // Raw Drive identifiers do not carry resource keys.
  }
  return resourceKey ? { id, type, resourceKey } : { id, type }
}

export function isDriveItemUri(uri: string | undefined): boolean {
  if (!uri) {
    return false
  }

  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return false
  }

  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.hostname !== 'drive.google.com'
  ) {
    return false
  }

  const pathname = url.pathname
  const hasDrivePathId =
    /\/drive\/folders\/[^/]+/.test(pathname) ||
    /\/file\/d\/[^/]+/.test(pathname) ||
    /\/d\/[^/]+/.test(pathname)
  const hasLegacyQueryId =
    (pathname === '/open' || pathname === '/uc') && !!url.searchParams.get('id')
  const hasHashId = /(?:^|[#&?])id=[^&]+/.test(url.hash)

  if (!hasDrivePathId && !hasLegacyQueryId && !hasHashId) {
    return false
  }

  try {
    parseDriveItem(uri)
    return true
  } catch {
    return false
  }
}

function createInitialNotebookJson(): string {
  const notebook = create(parser_pb.NotebookSchema, {
    cells: [],
  })
  return toJsonString(
    parser_pb.NotebookSchema,
    notebook,
    NOTEBOOK_JSON_WRITE_OPTIONS
  )
}

function extractBody(response: { body?: string; result?: unknown }): string {
  if (typeof response.body === 'string') {
    return response.body
  }
  if (typeof response.result === 'string') {
    return response.result
  }
  if (response.result && typeof response.result === 'object') {
    return JSON.stringify(response.result)
  }
  throw new Error('Google Drive response did not include any content')
}

export interface DriveCreateOptions {
  createOperationId?: string
  expectedContentChecksum?: string
  expectedRequestFingerprint?: string
  fileId?: string
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export class DriveNotebookStore {
  // ensureAccessToken is injected because it comes from the GoogleAuthContext
  constructor(
    private readonly ensureAccessToken: (options?: {
      interactive?: boolean
      forceRefresh?: boolean
    }) => Promise<string>
  ) {}

  private readonly lastReadVersion = new Map<string, string>()

  getAccessToken(options?: {
    interactive?: boolean
    forceRefresh?: boolean
  }): Promise<string> {
    return this.ensureAccessToken(options)
  }

  private async getFilesClient(): Promise<DriveFilesClient> {
    const token = await this.ensureAccessToken({ interactive: false })
    return ensureDriveFilesClient(token)
  }

  private async getResourceAccessToken(forceRefresh = false): Promise<string> {
    try {
      return await this.ensureAccessToken({ interactive: false, forceRefresh })
    } catch (error) {
      throw new LinkedResourceError(
        'AUTH_REQUIRED',
        'Sign in to Google Drive to load this resource',
        { cause: error }
      )
    }
  }

  private async resourceFetch(
    input: string,
    init: RequestInit = {}
  ): Promise<Response> {
    const configuredOrigin = new URL(driveApiBaseUrl()).origin
    let requestOrigin: string
    try {
      requestOrigin = new URL(input).origin
    } catch (error) {
      throw new LinkedResourceError(
        'PROVIDER_UNAVAILABLE',
        'Google Drive request URL is invalid',
        { cause: error }
      )
    }
    if (requestOrigin !== configuredOrigin) {
      throw new LinkedResourceError(
        'PROVIDER_UNAVAILABLE',
        'Google Drive refused to send credentials to an unexpected origin'
      )
    }
    const request = async (forceRefresh: boolean) => {
      const token = await this.getResourceAccessToken(forceRefresh)
      return fetch(input, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers).entries()),
          Authorization: `Bearer ${token}`,
        },
      })
    }
    let response = await request(false)
    if (response.status === 401 && !init.signal?.aborted) {
      response = await request(true)
    }
    return response
  }

  async getPrincipal(): Promise<{ permissionId: string }> {
    const response = await this.resourceFetch(
      driveApiUrl('/drive/v3/about', { fields: 'user(permissionId)' }),
      {}
    )
    if (!response.ok) {
      throw await driveErrorFromResponse(response, 'metadata')
    }
    const body = (await response.json()) as {
      user?: { permissionId?: unknown }
    }
    const permissionId = optionalString(body.user?.permissionId)
    if (!permissionId) {
      throw new LinkedResourceError(
        'PROVIDER_UNAVAILABLE',
        'Google Drive did not return a principal identifier'
      )
    }
    return { permissionId }
  }

  async getResourceMetadata(uri: string): Promise<DriveResourceMetadata> {
    const { id, type, resourceKey } = parseDriveItem(uri)
    if (type !== NotebookStoreItemType.File) {
      throw new LinkedResourceError(
        'UNSUPPORTED_MEDIA_TYPE',
        'Linked Google Drive resources must reference a file'
      )
    }
    const response = await this.resourceFetch(
      driveApiUrl(`/drive/v3/files/${encodeURIComponent(id)}`, {
        supportsAllDrives: 'true',
        fields: DRIVE_RESOURCE_FIELDS,
        ...(resourceKey ? { resourceKey } : {}),
      }),
      {}
    )
    if (!response.ok) {
      throw await driveErrorFromResponse(response, 'metadata')
    }
    return normalizeDriveResourceMetadata(
      (await response.json()) as Record<string, unknown>,
      id
    )
  }

  async fetchResource(
    uri: string,
    options: DriveResourceFetchOptions = {}
  ): Promise<Response> {
    const { id, type, resourceKey } = parseDriveItem(uri)
    if (type !== NotebookStoreItemType.File) {
      throw new LinkedResourceError(
        'UNSUPPORTED_MEDIA_TYPE',
        'Linked Google Drive resources must reference a file'
      )
    }
    const response = await this.resourceFetch(
      driveApiUrl(`/drive/v3/files/${encodeURIComponent(id)}`, {
        supportsAllDrives: 'true',
        alt: 'media',
        ...(resourceKey ? { resourceKey } : {}),
      }),
      { signal: options.signal }
    )
    if (!response.ok) {
      throw await driveErrorFromResponse(response, 'download')
    }
    return response
  }

  fetch(
    uri: string,
    options: DriveResourceFetchOptions = {}
  ): Promise<Response> {
    return this.fetchResource(uri, options)
  }

  private async findResourceByUploadOperation(
    parentUri: string,
    operationId: string
  ): Promise<DriveResourceMetadata | null> {
    const parent = parseDriveItem(parentUri)
    if (parent.type !== NotebookStoreItemType.Folder) {
      throw new Error('Drive resource upload requires a folder URI')
    }
    const result = await this.search(
      {
        q:
          `'${escapeDriveQueryValue(parent.id)}' in parents and trashed = false and ` +
          `appProperties has { key='${DRIVE_UPLOAD_OPERATION_PROPERTY}' and ` +
          `value='${escapeDriveQueryValue(operationId)}' }`,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        orderBy: 'createdTime asc',
        pageSize: 2,
        fields: `files(${DRIVE_RESOURCE_FIELDS})`,
      },
      driveResourceKeyHeaders(parent)
    )
    if (result.files.length > 1) {
      throw new LinkedResourceError(
        'RESOURCE_CHANGED',
        `Multiple Drive files use upload operation ${operationId}`
      )
    }
    const file = result.files[0]
    return file
      ? normalizeDriveResourceMetadata(file as Record<string, unknown>)
      : null
  }

  async uploadResource(
    parentUri: string,
    name: string,
    body: BinaryBody,
    options: DriveResourceUploadOptions
  ): Promise<DriveResourceMetadata> {
    const parent = parseDriveItem(parentUri)
    if (parent.type !== NotebookStoreItemType.Folder) {
      throw new Error('Drive resource upload requires a folder URI')
    }
    const normalizedName = name.trim()
    const normalizedOperationId = options.operationId.trim()
    if (!normalizedName || !normalizedOperationId) {
      throw new Error('Drive resource upload requires a name and operation ID')
    }
    const existing = await this.findResourceByUploadOperation(
      parentUri,
      normalizedOperationId
    )
    if (existing) {
      options.onProgress?.(existing.sizeBytes ?? 0, existing.sizeBytes ?? 0)
      return existing
    }

    const blob = binaryBodyAsBlob(
      body,
      options.mimeType || 'application/octet-stream'
    )
    const metadata = {
      name: normalizedName,
      mimeType: blob.type || 'application/octet-stream',
      parents: [parent.id],
      appProperties: {
        ...options.appProperties,
        [DRIVE_ASSET_PROPERTY]: 'true',
        [DRIVE_UPLOAD_OPERATION_PROPERTY]: normalizedOperationId,
      },
    }

    let initiation: Response
    try {
      initiation = await this.resourceFetch(
        driveApiUrl('/upload/drive/v3/files', {
          uploadType: 'resumable',
          supportsAllDrives: 'true',
          fields: DRIVE_RESOURCE_FIELDS,
        }),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': blob.type || 'application/octet-stream',
            'X-Upload-Content-Length': String(blob.size),
            ...driveResourceKeyHeaders(parent),
          },
          body: JSON.stringify(metadata),
          signal: options.signal,
        }
      )
    } catch (error) {
      if (options.signal?.aborted) {
        throw new LinkedResourceError(
          'UPLOAD_INTERRUPTED',
          'Upload cancelled',
          {
            cause: error,
          }
        )
      }
      const recovered = await this.findResourceByUploadOperation(
        parentUri,
        normalizedOperationId
      ).catch(() => null)
      if (recovered) {
        return recovered
      }
      throw new LinkedResourceError(
        'UPLOAD_INTERRUPTED',
        'Google Drive upload could not be started',
        { cause: error }
      )
    }
    if (!initiation.ok) {
      throw await driveErrorFromResponse(initiation, 'upload')
    }
    const location = initiation.headers.get('Location')
    if (!location) {
      throw new LinkedResourceError(
        'PROVIDER_UNAVAILABLE',
        'Google Drive did not return a resumable upload URL'
      )
    }

    let uploadedBytes = 0
    let finalMetadata: DriveResourceMetadata | null = null
    do {
      const endExclusive = Math.min(
        blob.size,
        uploadedBytes + DRIVE_RESUMABLE_CHUNK_BYTES
      )
      const chunk = blob.slice(uploadedBytes, endExclusive, blob.type)
      const contentRange =
        blob.size === 0
          ? 'bytes */0'
          : `bytes ${uploadedBytes}-${endExclusive - 1}/${blob.size}`
      let response: Response
      try {
        response = await this.resourceFetch(location, {
          method: 'PUT',
          headers: {
            'Content-Type': blob.type || 'application/octet-stream',
            'Content-Length': String(chunk.size),
            'Content-Range': contentRange,
          },
          body: chunk,
          signal: options.signal,
        })
      } catch (error) {
        throw new LinkedResourceError(
          'UPLOAD_INTERRUPTED',
          options.signal?.aborted
            ? 'Upload cancelled'
            : 'Google Drive upload was interrupted',
          { cause: error }
        )
      }
      if (response.status === 308) {
        uploadedBytes = endExclusive
        options.onProgress?.(uploadedBytes, blob.size)
        continue
      }
      if (!response.ok) {
        throw await driveErrorFromResponse(response, 'upload')
      }
      uploadedBytes = blob.size
      options.onProgress?.(uploadedBytes, blob.size)
      finalMetadata = normalizeDriveResourceMetadata(
        (await response.json()) as Record<string, unknown>
      )
    } while (!finalMetadata)

    return finalMetadata
  }

  async resolveAssetFolder(
    notebookUri: string,
    notebookName: string
  ): Promise<string> {
    const notebook = await this.getResourceMetadata(notebookUri)
    const notebookFileId = parseDriveItem(notebook.uri).id
    const parentId = notebook.parents?.[0]
    if (!parentId) {
      throw new LinkedResourceError(
        'ACCESS_DENIED',
        'The notebook does not have a Drive parent folder'
      )
    }
    const query =
      `'${escapeDriveQueryValue(parentId)}' in parents and trashed = false and ` +
      `mimeType = '${DRIVE_FOLDER_MIME_TYPE}' and ` +
      `appProperties has { key='${DRIVE_ASSET_FOLDER_PROPERTY}' and value='true' } and ` +
      `appProperties has { key='${DRIVE_ASSET_NOTEBOOK_PROPERTY}' and ` +
      `value='${escapeDriveQueryValue(notebookFileId)}' }`
    const result = await this.search({
      q: query,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      orderBy: 'createdTime asc',
      pageSize: 2,
      fields: 'files(id,name,mimeType,parents,appProperties)',
    })
    if (result.files.length > 1) {
      throw new LinkedResourceError(
        'RESOURCE_CHANGED',
        'Multiple asset folders exist for this notebook'
      )
    }
    const existingId = result.files[0]?.id
    if (existingId) {
      return driveFolderUrl(existingId)
    }

    const client = await this.getFilesClient()
    const folder = await createDriveItem(client, {
      name: `${notebookName}.assets`,
      mimeType: DRIVE_FOLDER_MIME_TYPE,
      parents: [parentId],
      appProperties: {
        [DRIVE_ASSET_FOLDER_PROPERTY]: 'true',
        [DRIVE_ASSET_NOTEBOOK_PROPERTY]: notebookFileId,
      },
    })
    if (!folder.id) {
      throw new LinkedResourceError(
        'PROVIDER_UNAVAILABLE',
        'Google Drive did not create the asset folder'
      )
    }
    return driveFolderUrl(folder.id)
  }

  /** Reserve a Drive file id so retries can target one stable identity. */
  async generateFileId(): Promise<string> {
    return (await this.getFilesClient()).generateFileId()
  }

  /** Return whether Drive permits a pre-generated file ID in this parent. */
  async canUsePreGeneratedFileId(parentUri: string): Promise<boolean> {
    const parent = parseDriveItem(parentUri)
    if (parent.type !== NotebookStoreItemType.Folder) {
      throw new Error(
        'DriveNotebookStore.canUsePreGeneratedFileId expects a folder URI'
      )
    }
    const response = await (
      await this.getFilesClient()
    ).get({
      fileId: parent.id,
      supportsAllDrives: true,
      fields: 'driveId',
      resourceKey: parent.resourceKey,
    })
    return !(response.result as DriveDoc | undefined)?.driveId
  }

  async create(
    parentUri: string,
    name: string,
    options: DriveCreateOptions = {}
  ): Promise<NotebookStoreItem> {
    const parent = parseDriveItem(parentUri)
    if (parent.type !== NotebookStoreItemType.Folder) {
      throw new Error('DriveNotebookStore.create expects a folder URI')
    }
    const client = await this.getFilesClient()
    const format = detectNotebookFileFormat(name)
    const mimeType = format === 'ipynb' ? IPYNB_MIME_TYPE : 'application/json'
    const parentHeaders = driveResourceKeyHeaders(parent)
    let file = await createDriveItem(
      client,
      {
        id: options.fileId,
        name,
        mimeType,
        parents: [parent.id],
        content:
          format === 'ipynb'
            ? createInitialNotebookFile(name)
            : createInitialNotebookJson(),
        ...(options.createOperationId
          ? {
              appProperties: {
                [DRIVE_CREATE_OPERATION_PROPERTY]: options.createOperationId,
                ...(options.expectedContentChecksum
                  ? {
                      [DRIVE_CREATE_EXPECTED_CHECKSUM_PROPERTY]:
                        options.expectedContentChecksum,
                    }
                  : {}),
                ...(options.expectedRequestFingerprint
                  ? {
                      [DRIVE_CREATE_EXPECTED_REQUEST_PROPERTY]:
                        options.expectedRequestFingerprint,
                    }
                  : {}),
              },
            }
          : {}),
      },
      parentHeaders
    )

    if (!file.id) {
      throw new Error('Failed to create Google Drive notebook file')
    }
    const fileId = file.id
    file = await client.ensureParent(file, parent.id, parentHeaders)
    const isFolder = file.mimeType === DRIVE_FOLDER_MIME_TYPE
    return {
      uri: isFolder ? driveFolderUrl(fileId) : driveFileUrl(fileId),
      name: file.name ?? name,
      type: isFolder
        ? NotebookStoreItemType.Folder
        : NotebookStoreItemType.File,
      children: [],
      remoteUri: isFolder ? driveFolderUrl(fileId) : driveFileUrl(fileId),
      mimeType: file.mimeType ?? mimeType,
      parents: [parentUri],
    }
  }

  async createContent(
    parentUri: string,
    name: string,
    content: string,
    mimeType: string = 'application/octet-stream',
    options: DriveCreateOptions = {}
  ): Promise<NotebookStoreItem> {
    const parent = parseDriveItem(parentUri)
    if (parent.type !== NotebookStoreItemType.Folder) {
      throw new Error('DriveNotebookStore.createContent expects a folder URI')
    }
    let client: DriveFilesClient
    try {
      client = await this.getFilesClient()
    } catch (error) {
      throw new DriveCreateNotCommittedError(
        'Google Drive create failed before a request was sent',
        error
      )
    }
    let file: DriveDoc
    const parentHeaders = driveResourceKeyHeaders(parent)
    try {
      file = await client.create(
        {
          id: options.fileId,
          name,
          mimeType,
          parents: [parent.id],
          content,
          ...(options.createOperationId
            ? {
                appProperties: {
                  [DRIVE_CREATE_OPERATION_PROPERTY]: options.createOperationId,
                  ...(options.expectedContentChecksum
                    ? {
                        [DRIVE_CREATE_EXPECTED_CHECKSUM_PROPERTY]:
                          options.expectedContentChecksum,
                      }
                    : {}),
                  ...(options.expectedRequestFingerprint
                    ? {
                        [DRIVE_CREATE_EXPECTED_REQUEST_PROPERTY]:
                          options.expectedRequestFingerprint,
                      }
                    : {}),
                },
              }
            : {}),
        },
        parentHeaders
      )
    } catch (error) {
      if (error instanceof DriveFileCreatedError) {
        throw error
      }
      const serviceAccountMessage =
        serviceAccountStorageQuotaErrorMessage(error)
      if (serviceAccountMessage) {
        throw new DriveCreateNotCommittedError(serviceAccountMessage, error)
      }
      if (options.fileId && driveErrorStatus(error) === 409) {
        const response = await client.get({
          fileId: options.fileId,
          supportsAllDrives: true,
          fields: 'id,name,mimeType,parents',
        })
        file = {
          id: options.fileId,
          ...(response.result as DriveDoc | undefined),
        }
      } else if (isDefinitelyRejectedCreate(error)) {
        throw new DriveCreateNotCommittedError(
          'Google Drive rejected the create request before committing a file',
          error
        )
      } else {
        throw error
      }
    }

    if (!file.id) {
      throw new Error('Failed to create Google Drive file')
    }
    const fileId = file.id
    file = await client.ensureParent(file, parent.id, parentHeaders)
    const isFolder = file.mimeType === DRIVE_FOLDER_MIME_TYPE
    return {
      uri: isFolder ? driveFolderUrl(fileId) : driveFileUrl(fileId),
      name: file.name ?? name,
      type: isFolder
        ? NotebookStoreItemType.Folder
        : NotebookStoreItemType.File,
      children: [],
      remoteUri: isFolder ? driveFolderUrl(fileId) : driveFileUrl(fileId),
      mimeType: file.mimeType ?? mimeType,
      parents: [parentUri],
    }
  }

  async findByCreateOperation(
    parentUri: string,
    createOperationId: string
  ): Promise<NotebookStoreItem | null> {
    const parent = parseDriveItem(parentUri)
    if (parent.type !== NotebookStoreItemType.Folder) {
      throw new Error(
        'DriveNotebookStore.findByCreateOperation expects a folder URI'
      )
    }
    if (!createOperationId) {
      throw new Error(
        'DriveNotebookStore.findByCreateOperation requires an operation id'
      )
    }

    const escapedParentId = escapeDriveQueryValue(parent.id)
    const escapedOperationId = escapeDriveQueryValue(createOperationId)
    const result = await this.search(
      {
        q:
          `'${escapedParentId}' in parents and trashed = false and ` +
          `appProperties has { key='${DRIVE_CREATE_OPERATION_PROPERTY}' and ` +
          `value='${escapedOperationId}' }`,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        orderBy: 'createdTime asc',
        pageSize: 2,
        fields: 'files(id,name,mimeType,parents,createdTime,appProperties)',
      },
      driveResourceKeyHeaders(parent)
    )

    if (result.files.length > 1) {
      throw new Error(
        `Multiple Drive files found for create operation ${createOperationId}`
      )
    }
    const file = result.files[0]
    if (!file?.id) {
      return null
    }

    const isFolder = file.mimeType === DRIVE_FOLDER_MIME_TYPE
    return {
      uri: isFolder ? driveFolderUrl(file.id) : driveFileUrl(file.id),
      name: file.name ?? 'Untitled item',
      type: isFolder
        ? NotebookStoreItemType.Folder
        : NotebookStoreItemType.File,
      children: [],
      remoteUri: isFolder ? driveFolderUrl(file.id) : driveFileUrl(file.id),
      mimeType: file.mimeType,
      parents: [parentUri],
    }
  }

  /**
   * Wait for Drive's search index to expose an idempotent create. Callers use
   * this before consuming a new reserved ID so a create committed by another
   * browser context has time to become visible.
   */
  async waitForCreateOperation(
    parentUri: string,
    createOperationId: string,
    initialDelayMs: number = 0
  ): Promise<NotebookStoreItem | null> {
    for (const delayMs of [initialDelayMs, 250, 500, 1_000, 2_000]) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      const file = await this.findByCreateOperation(
        parentUri,
        createOperationId
      )
      if (file) {
        return file
      }
    }
    return null
  }

  /**
   * Mark a two-step metadata/media creation as complete. The expected checksum
   * remains in private app properties so a retry can distinguish an incomplete
   * upload from a notebook that a user edited after creation completed.
   */
  async markCreateOperationComplete(
    uri: string,
    expectedChecksum: string
  ): Promise<void> {
    const { id, type } = parseDriveItem(uri)
    if (type !== NotebookStoreItemType.File) {
      throw new Error(
        'DriveNotebookStore.markCreateOperationComplete expects a file URI'
      )
    }
    const client = await this.getFilesClient()
    const metadataResponse = await client.get({
      fileId: id,
      supportsAllDrives: true,
      fields: 'appProperties',
    })
    const appProperties =
      (metadataResponse.result as DriveVersionMetadata | undefined)
        ?.appProperties ?? {}
    const recordedExpected =
      appProperties[DRIVE_CREATE_EXPECTED_CHECKSUM_PROPERTY]
    if (recordedExpected && recordedExpected !== expectedChecksum) {
      throw new Error(
        'IDEMPOTENCY_CONFLICT: Drive create operation was already used for different notebook content'
      )
    }
    await client.update({
      id,
      appProperties: {
        ...appProperties,
        [DRIVE_CREATE_EXPECTED_CHECKSUM_PROPERTY]: expectedChecksum,
        [DRIVE_CREATE_COMPLETED_CHECKSUM_PROPERTY]: expectedChecksum,
      },
    })
  }

  async createFolder(
    parentUri: string,
    name: string
  ): Promise<NotebookStoreItem> {
    const parent = parseDriveItem(parentUri)
    if (parent.type !== NotebookStoreItemType.Folder) {
      throw new Error('DriveNotebookStore.createFolder expects a folder URI')
    }
    const client = await this.getFilesClient()
    const parentHeaders = driveResourceKeyHeaders(parent)
    let folder = await createDriveItem(
      client,
      {
        name,
        mimeType: DRIVE_FOLDER_MIME_TYPE,
        parents: [parent.id],
      },
      parentHeaders
    )

    if (!folder.id) {
      throw new Error('Failed to create Google Drive folder')
    }
    const folderId = folder.id
    folder = await client.ensureParent(folder, parent.id, parentHeaders)
    const folderUri = driveFolderUrl(folderId)
    return {
      uri: folderUri,
      name: folder.name ?? name,
      type: NotebookStoreItemType.Folder,
      children: [],
      remoteUri: folderUri,
      mimeType: folder.mimeType ?? DRIVE_FOLDER_MIME_TYPE,
      parents: [parentUri],
    }
  }

  async save(
    uri: string,
    notebook: parser_pb.Notebook
  ): Promise<ConflictResult> {
    const { id, type, resourceKey } = parseDriveItem(uri)
    if (type !== NotebookStoreItemType.File) {
      throw new Error('DriveNotebookStore.save expects a file URI')
    }
    const client = await this.getFilesClient()
    const metadataResponse = await client.get({
      fileId: id,
      supportsAllDrives: true,
      //fields: "md5Checksum",
      fields: VERSION_FIELDS,
      resourceKey,
    })
    const remoteMd5 =
      (metadataResponse.result as { md5Checksum?: string } | undefined)
        ?.md5Checksum ?? null
    const lastRead = this.lastReadVersion.get(uri) ?? null
    if (lastRead && remoteMd5 && remoteMd5 !== lastRead) {
      console.error(
        'DriveNotebookStore.save aborted due to checksum mismatch',
        {
          uri,
          expected: lastRead,
          actual: remoteMd5,
        }
      )
      return { conflicted: true }
    }
    const json = toJsonString(
      parser_pb.NotebookSchema,
      notebook,
      NOTEBOOK_JSON_WRITE_OPTIONS
    )

    await client.update({
      id,
      mimeType: 'application/json',
      content: json,
      resourceKey,
    })
    const updatedMetadataResponse = await client.get({
      fileId: id,
      supportsAllDrives: true,
      fields: VERSION_FIELDS,
      resourceKey,
    })
    const updatedMd5 =
      (updatedMetadataResponse.result as { md5Checksum?: string } | undefined)
        ?.md5Checksum ?? null
    if (updatedMd5) {
      this.lastReadVersion.set(uri, updatedMd5)
    } else {
      this.lastReadVersion.delete(uri)
    }
    return { conflicted: false }
  }

  async load(uri: string): Promise<parser_pb.Notebook> {
    const { id, type, resourceKey } = parseDriveItem(uri)
    if (type !== NotebookStoreItemType.File) {
      throw new Error('DriveNotebookStore.load expects a file URI')
    }
    const client = await this.getFilesClient()
    const metadataResponse = await client.get({
      fileId: id,
      supportsAllDrives: true,
      fields: VERSION_FIELDS,
      resourceKey,
    })
    const md5 =
      (metadataResponse.result as { md5Checksum?: string } | undefined)
        ?.md5Checksum ?? null
    if (md5) {
      this.lastReadVersion.set(uri, md5)
    } else {
      this.lastReadVersion.delete(uri)
    }
    const response = await client.get({
      fileId: id,
      supportsAllDrives: true,
      alt: 'media',
      resourceKey,
    })

    const body = extractBody(response)

    return fromJsonString(parser_pb.NotebookSchema, body, {
      ignoreUnknownFields: true,
    })
  }

  async list(uri: string): Promise<NotebookStoreItem[]> {
    const item = parseDriveItem(uri)
    const { id, type } = item
    if (type !== NotebookStoreItemType.Folder) {
      throw new Error(
        'Google Drive URI must reference a folder to list contents'
      )
    }
    const files: DriveSearchFile[] = []
    let pageToken: string | undefined

    do {
      const response = await this.search(
        {
          q: `'${id}' in parents and trashed = false`,
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
          orderBy: 'name',
          pageSize: 1000,
          pageToken,
          fields: 'nextPageToken,files(id,name,mimeType,resourceKey)',
        },
        driveResourceKeyHeaders(item)
      )
      files.push(...response.files)
      pageToken = response.nextPageToken
    } while (pageToken)

    const validFiles = files.filter(
      (file): file is DriveSearchFile & { id: string } => Boolean(file?.id)
    )

    return validFiles.map((file) => {
      const isFolder = file.mimeType === DRIVE_FOLDER_MIME_TYPE
      return {
        uri: isFolder
          ? driveFolderUrl(file.id, file.resourceKey)
          : driveFileUrl(file.id, file.resourceKey),
        name: file.name ?? 'Untitled item',
        type: isFolder
          ? NotebookStoreItemType.Folder
          : NotebookStoreItemType.File,
        children: [],
        remoteUri: isFolder
          ? driveFolderUrl(file.id, file.resourceKey)
          : driveFileUrl(file.id, file.resourceKey),
        mimeType: file.mimeType,
        parents: [],
      }
    })
  }

  /**
   * Runs a Google Drive files.list request without narrowing its query surface.
   * The request is forwarded as-is so callers can use the complete Drive `q`
   * grammar and list parameters. Optional headers support resource-key folder
   * traversal. Returned files retain their Drive metadata and gain a
   * Runme-compatible URI when the response includes an id and MIME type.
   */
  async search(
    request: Record<string, unknown>,
    headers: Record<string, string> = {}
  ): Promise<DriveSearchResult> {
    const client = await this.getFilesClient()
    const response = await client.list(request, headers)
    const result = response.result ?? {}
    return {
      ...result,
      files: (result.files ?? []).map((file) => {
        if (!file.id || !file.mimeType) {
          return { ...file }
        }
        const isFolder = file.mimeType === DRIVE_FOLDER_MIME_TYPE
        return {
          ...file,
          uri: isFolder
            ? driveFolderUrl(file.id, file.resourceKey)
            : driveFileUrl(file.id, file.resourceKey),
        }
      }),
    }
  }

  async listComments(uri: string): Promise<DriveComment[]> {
    const item = parseDriveItem(uri)
    if (item.type !== NotebookStoreItemType.File) {
      throw new Error('DriveNotebookStore.listComments expects a file URI')
    }
    const client = await this.getFilesClient()
    const headers = driveResourceKeyHeaders(item)
    const comments: DriveComment[] = []
    let pageToken: string | undefined

    do {
      const response = await client.listComments(
        {
          fileId: item.id,
          supportsAllDrives: true,
          includeDeleted: true,
          fields: DRIVE_COMMENT_LIST_FIELDS,
          ...(pageToken ? { pageToken } : {}),
        },
        headers
      )
      comments.push(...(response.result?.comments ?? []))
      pageToken = optionalString(response.result?.nextPageToken)
    } while (pageToken)

    return comments
  }

  async createComment(
    uri: string,
    content: string,
    options?:
      | string
      | {
          anchor?: string
          quotedFileContent?: { mimeType: 'text/plain'; value: string }
        }
  ): Promise<DriveComment> {
    const item = parseDriveItem(uri)
    if (item.type !== NotebookStoreItemType.File) {
      throw new Error('DriveNotebookStore.createComment expects a file URI')
    }
    const trimmedContent = content.trim()
    if (!trimmedContent) {
      throw new Error('DriveNotebookStore.createComment requires content')
    }
    const anchor = typeof options === 'string' ? options : options?.anchor
    const quotedFileContent =
      typeof options === 'string' ? undefined : options?.quotedFileContent
    const client = await this.getFilesClient()
    const response = await client.createComment({
      fileId: item.id,
      resource: {
        content: trimmedContent,
        ...(anchor ? { anchor } : {}),
        ...(quotedFileContent ? { quotedFileContent } : {}),
      },
      fields: DRIVE_COMMENT_FIELDS,
      headers: driveResourceKeyHeaders(item),
    })
    return (response.result ?? {}) as DriveComment
  }

  async replyToComment(
    uri: string,
    commentId: string,
    content: string
  ): Promise<DriveReply> {
    const item = parseDriveItem(uri)
    if (item.type !== NotebookStoreItemType.File) {
      throw new Error('DriveNotebookStore.replyToComment expects a file URI')
    }
    const trimmedContent = content.trim()
    if (!commentId.trim()) {
      throw new Error('DriveNotebookStore.replyToComment requires a comment id')
    }
    if (!trimmedContent) {
      throw new Error('DriveNotebookStore.replyToComment requires content')
    }
    const client = await this.getFilesClient()
    const response = await client.createReply({
      fileId: item.id,
      commentId: commentId.trim(),
      resource: {
        content: trimmedContent,
      },
      headers: driveResourceKeyHeaders(item),
    })
    return (response.result ?? {}) as DriveReply
  }

  async resolveComment(uri: string, commentId: string): Promise<DriveReply> {
    const item = parseDriveItem(uri)
    if (item.type !== NotebookStoreItemType.File) {
      throw new Error('DriveNotebookStore.resolveComment expects a file URI')
    }
    if (!commentId.trim()) {
      throw new Error('DriveNotebookStore.resolveComment requires a comment id')
    }
    const client = await this.getFilesClient()
    const response = await client.createReply({
      fileId: item.id,
      commentId: commentId.trim(),
      resource: {
        action: 'resolve',
      },
      headers: driveResourceKeyHeaders(item),
    })
    return (response.result ?? {}) as DriveReply
  }

  async reopenComment(uri: string, commentId: string): Promise<DriveReply> {
    const item = parseDriveItem(uri)
    if (item.type !== NotebookStoreItemType.File) {
      throw new Error('DriveNotebookStore.reopenComment expects a file URI')
    }
    if (!commentId.trim()) {
      throw new Error('DriveNotebookStore.reopenComment requires a comment id')
    }
    const client = await this.getFilesClient()
    const response = await client.createReply({
      fileId: item.id,
      commentId: commentId.trim(),
      resource: {
        action: 'reopen',
      },
      headers: driveResourceKeyHeaders(item),
    })
    return (response.result ?? {}) as DriveReply
  }

  async getType(uri: string): Promise<NotebookStoreItemType> {
    return parseDriveItem(uri).type
  }

  async getChecksum(uri: string): Promise<string | null> {
    return (await this.getVersionMetadata(uri))?.md5Checksum ?? null
  }

  async getVersionMetadata(uri: string): Promise<DriveVersionMetadata | null> {
    const { id, type, resourceKey } = parseDriveItem(uri)
    if (type !== NotebookStoreItemType.File) {
      throw new Error(
        'DriveNotebookStore.getVersionMetadata expects a file URI'
      )
    }
    const client = await this.getFilesClient()
    const metadataResponse = await client.get({
      fileId: id,
      supportsAllDrives: true,
      fields: VERSION_FIELDS,
      resourceKey,
    })
    const result = metadataResponse.result as DriveVersionMetadata | undefined
    if (result?.md5Checksum) {
      this.lastReadVersion.set(uri, result.md5Checksum)
    } else {
      this.lastReadVersion.delete(uri)
    }
    return result ?? null
  }

  async listRevisions(uri: string): Promise<DriveRevision[]> {
    const item = parseDriveItem(uri)
    if (item.type !== NotebookStoreItemType.File) {
      throw new Error('DriveNotebookStore.listRevisions expects a file URI')
    }
    const client = await this.getFilesClient()
    const revisions: DriveRevision[] = []
    let pageToken: string | undefined

    do {
      const response = await client.listRevisions(
        {
          fileId: item.id,
          supportsAllDrives: true,
          fields:
            'nextPageToken,revisions(id,mimeType,modifiedTime,md5Checksum,size,keepForever,lastModifyingUser(displayName,emailAddress))',
          ...(pageToken ? { pageToken } : {}),
        },
        driveResourceKeyHeaders(item)
      )
      revisions.push(...(response.result?.revisions ?? []))
      pageToken = optionalString(response.result?.nextPageToken)
    } while (pageToken)

    return revisions.map(normalizeDriveRevision)
  }

  async loadRevision(
    uri: string,
    revisionId: string
  ): Promise<parser_pb.Notebook> {
    const item = parseDriveItem(uri)
    if (item.type !== NotebookStoreItemType.File) {
      throw new Error('DriveNotebookStore.loadRevision expects a file URI')
    }
    if (!revisionId?.trim()) {
      throw new Error('DriveNotebookStore.loadRevision requires a revision id')
    }
    const client = await this.getFilesClient()
    const response = await client.getRevision(
      {
        fileId: item.id,
        revisionId: revisionId.trim(),
        supportsAllDrives: true,
        alt: 'media',
      },
      driveResourceKeyHeaders(item)
    )
    const body = extractBody(response)
    return fromJsonString(parser_pb.NotebookSchema, body, {
      ignoreUnknownFields: true,
    })
  }

  async loadRevisionContent(uri: string, revisionId: string): Promise<string> {
    const item = parseDriveItem(uri)
    if (item.type !== NotebookStoreItemType.File) {
      throw new Error(
        'DriveNotebookStore.loadRevisionContent expects a file URI'
      )
    }
    if (!revisionId?.trim()) {
      throw new Error(
        'DriveNotebookStore.loadRevisionContent requires a revision id'
      )
    }
    const client = await this.getFilesClient()
    const response = await client.getRevision(
      {
        fileId: item.id,
        revisionId: revisionId.trim(),
        supportsAllDrives: true,
        alt: 'media',
      },
      driveResourceKeyHeaders(item)
    )
    return extractBody(response)
  }

  async rename(uri: string, name: string): Promise<NotebookStoreItem> {
    const { id, type, resourceKey } = parseDriveItem(uri)
    if (
      type !== NotebookStoreItemType.File &&
      type !== NotebookStoreItemType.Folder
    ) {
      throw new Error('DriveNotebookStore.rename expects a file or folder URI')
    }
    const client = await this.getFilesClient()
    appLogger.info('Dispatching Drive rename', {
      attrs: {
        scope: 'storage.rename',
        code: 'DRIVE_RENAME_REQUESTED',
        uri,
        fileId: id,
        requestedName: name,
        itemType: type,
      },
    })
    const file = await client.update({
      id,
      name,
      resourceKey,
    })
    appLogger.info('Drive rename completed', {
      attrs: {
        scope: 'storage.rename',
        code: 'DRIVE_RENAME_COMPLETED',
        uri,
        fileId: file.id ?? id,
        requestedName: name,
        returnedName: file.name,
        returnedMimeType: file.mimeType,
      },
    })

    const fileId = file.id ?? id
    const mimeType = file.mimeType
    const isFolder = mimeType === DRIVE_FOLDER_MIME_TYPE
    const itemUri = isFolder
      ? driveFolderUrl(fileId, resourceKey)
      : driveFileUrl(fileId, resourceKey)
    return {
      uri: itemUri,
      name: file.name ?? name,
      type: isFolder
        ? NotebookStoreItemType.Folder
        : NotebookStoreItemType.File,
      children: [],
      remoteUri: itemUri,
      mimeType,
      parents: [],
    }
  }

  async move(
    uri: string,
    sourceParentUri: string,
    destinationParentUri: string
  ): Promise<NotebookStoreItem> {
    const item = parseDriveItem(uri)
    const sourceParent = parseDriveItem(sourceParentUri)
    const destinationParent = parseDriveItem(destinationParentUri)
    if (
      item.type !== NotebookStoreItemType.File &&
      item.type !== NotebookStoreItemType.Folder
    ) {
      throw new Error('DriveNotebookStore.move expects a file or folder URI')
    }
    if (
      sourceParent.type !== NotebookStoreItemType.Folder ||
      destinationParent.type !== NotebookStoreItemType.Folder
    ) {
      throw new Error('DriveNotebookStore.move expects folder parent URIs')
    }
    if (sourceParent.id === destinationParent.id) {
      throw new Error(
        'DriveNotebookStore.move expects a new destination folder'
      )
    }

    const client = await this.getFilesClient()
    const file = await client.move(
      item.id,
      sourceParent.id,
      destinationParent.id,
      item.resourceKey,
      driveResourceKeysHeaders([sourceParent, destinationParent])
    )
    const fileId = file.id ?? item.id
    const isFolder =
      file.mimeType === DRIVE_FOLDER_MIME_TYPE ||
      item.type === NotebookStoreItemType.Folder
    const itemUri = isFolder
      ? driveFolderUrl(fileId, item.resourceKey)
      : driveFileUrl(fileId, item.resourceKey)
    return {
      uri: itemUri,
      name: file.name ?? uri,
      type: isFolder
        ? NotebookStoreItemType.Folder
        : NotebookStoreItemType.File,
      children: [],
      remoteUri: itemUri,
      mimeType: file.mimeType,
      parents: [destinationParentUri],
    }
  }

  async moveToTrash(uri: string): Promise<NotebookStoreItem> {
    const { id, type, resourceKey } = parseDriveItem(uri)
    if (type !== NotebookStoreItemType.File) {
      throw new Error('DriveNotebookStore.moveToTrash expects a file URI')
    }
    const client = await this.getFilesClient()
    const file = await client.update({
      id,
      trashed: true,
      resourceKey,
    })

    const fileId = file.id ?? id
    return {
      uri: driveFileUrl(fileId, resourceKey),
      name: file.name ?? uri,
      type: NotebookStoreItemType.File,
      children: [],
      remoteUri: driveFileUrl(fileId, resourceKey),
      mimeType: file.mimeType,
      parents: [],
    }
  }

  /**
   * Save arbitrary file content to Drive. Intended for non-notebook sidecars
   * such as Markdown indexes.
   */
  async saveContent(
    uri: string,
    content: string,
    mimeType: string = 'application/octet-stream'
  ): Promise<void> {
    const { id, type, resourceKey } = parseDriveItem(uri)
    if (type !== NotebookStoreItemType.File) {
      throw new Error('DriveNotebookStore.saveContent expects a file URI')
    }
    const client = await this.getFilesClient()
    await client.update({
      id,
      mimeType,
      content,
      resourceKey,
    })
  }

  /**
   * Replace file content only while Drive still exposes the exact revision
   * previously inspected by the caller. The metadata recheck closes the gap
   * before the request, and If-Match closes the gap during the media upload.
   */
  async saveContentIfVersion(
    uri: string,
    content: string,
    mimeType: string,
    expected: { checksum?: string; revisionId?: string }
  ): Promise<boolean> {
    const { id, type, resourceKey } = parseDriveItem(uri)
    if (type !== NotebookStoreItemType.File) {
      throw new Error(
        'DriveNotebookStore.saveContentIfVersion expects a file URI'
      )
    }
    const client = await this.getFilesClient()
    const { metadata, etag } = await client.getVersionMetadataWithEtag(
      id,
      resourceKey
    )
    const actualChecksum = metadata?.md5Checksum ?? ''
    const expectedChecksum = expected.checksum ?? ''
    if (
      actualChecksum !== expectedChecksum ||
      (expected.revisionId !== undefined &&
        metadata?.headRevisionId !== expected.revisionId)
    ) {
      return false
    }
    if (!etag) {
      // Refuse an unconditional repair if the transport did not expose the
      // validator needed to protect a collaborator's concurrent edit.
      return false
    }
    return client.setContentIfMatch(id, content, mimeType, etag, resourceKey)
  }

  async loadContent(uri: string): Promise<string> {
    const { id, type, resourceKey } = parseDriveItem(uri)
    if (type !== NotebookStoreItemType.File) {
      throw new Error('DriveNotebookStore.loadContent expects a file URI')
    }
    const client = await this.getFilesClient()
    const response = await client.get({
      fileId: id,
      supportsAllDrives: true,
      alt: 'media',
      resourceKey,
    })
    return extractBody(response)
  }

  async getMetadata(uri: string): Promise<NotebookStoreItem | null> {
    const { id, type, resourceKey } = parseDriveItem(uri)
    if (
      type !== NotebookStoreItemType.File &&
      type !== NotebookStoreItemType.Folder
    ) {
      return null
    }
    const client = await this.getFilesClient()
    const response = await client.get({
      fileId: id,
      supportsAllDrives: true,
      fields: 'id,name,mimeType,parents,driveId,resourceKey',
      resourceKey,
    })
    const result = response.result as {
      name?: string
      mimeType?: string
      parents?: string[]
      driveId?: string
      resourceKey?: string
    }
    const isFolder = result?.mimeType === DRIVE_FOLDER_MIME_TYPE
    let displayName = result?.name
    if (isFolder && result?.driveId === id && result.name === 'Drive') {
      try {
        const driveResponse = await client.getDrive({
          driveId: id,
          fields: 'id,name',
        })
        displayName = driveResponse.result?.name ?? displayName
      } catch (error) {
        console.error('Failed to resolve shared Drive name', error)
      }
    }
    const resolvedType = isFolder
      ? NotebookStoreItemType.Folder
      : NotebookStoreItemType.File
    const parentIds = Array.isArray(result.parents)
      ? result.parents.filter((parentId): parentId is string =>
          Boolean(parentId)
        )
      : []
    const parentUris = parentIds.map((parentId) => {
      if (parentId === 'root') {
        return parentId
      }
      return driveFolderUrl(parentId)
    })
    return {
      uri,
      name: displayName ?? uri,
      type: resolvedType,
      children: [],
      remoteUri: uri,
      mimeType: result?.mimeType,
      parents: parentUris,
    }
  }

  /** Return null only when Drive definitively reports that the item is absent. */
  async getMetadataIfExists(uri: string): Promise<NotebookStoreItem | null> {
    try {
      return await this.getMetadata(uri)
    } catch (error) {
      if (driveErrorStatus(error) === 404) {
        return null
      }
      throw error
    }
  }
}

export async function fetchSharedNotebookPreflight(
  uri: string,
  ensureAccessToken: () => Promise<string>
): Promise<{
  item: NotebookStoreItem
  parents: NotebookStoreItem[]
  preflight: SharedNotebookPreflight
}> {
  const { id, type } = parseDriveItem(uri)
  if (
    type !== NotebookStoreItemType.File &&
    type !== NotebookStoreItemType.Folder
  ) {
    throw new Error('Unsupported Google Drive item type')
  }

  const client = await ensureDriveFilesClient(await ensureAccessToken())

  const metadataResponse = await client.get({
    fileId: id,
    supportsAllDrives: true,
    fields:
      'id,name,mimeType,parents,driveId,ownedByMe,modifiedTime,version,' +
      'headRevisionId,md5Checksum,size,' +
      'owners(displayName,emailAddress,permissionId,me),' +
      'sharingUser(displayName,emailAddress,permissionId,me),' +
      'lastModifyingUser(displayName,emailAddress,permissionId,me),' +
      'capabilities(canDownload)',
  })

  const meta = (metadataResponse.result ?? {}) as DriveFileMetadata
  if (!meta.id) {
    throw new Error('Google Drive did not return file metadata')
  }

  const parentIds = Array.isArray(meta.parents) ? meta.parents : []
  const parentUris = parentIds
    .filter((parentId): parentId is string => Boolean(parentId))
    .map((parentId) =>
      parentId === 'root' ? parentId : driveFolderUrl(parentId)
    )

  const isFolder = meta.mimeType === DRIVE_FOLDER_MIME_TYPE
  const item: NotebookStoreItem = {
    uri: isFolder ? driveFolderUrl(meta.id) : driveFileUrl(meta.id),
    name: meta.name ?? 'Untitled item',
    type: isFolder ? NotebookStoreItemType.Folder : NotebookStoreItemType.File,
    children: [],
    remoteUri: isFolder ? driveFolderUrl(meta.id) : driveFileUrl(meta.id),
    mimeType: meta.mimeType,
    parents: parentUris,
  }

  const parents: NotebookStoreItem[] = []
  for (const parentId of parentIds) {
    try {
      const parentResponse = await client.get({
        fileId: parentId,
        supportsAllDrives: true,
        fields: 'id,name,mimeType',
      })
      const parentMeta = (parentResponse.result ?? {}) as DriveFileMetadata
      if (!parentMeta.id) {
        continue
      }
      const parentIsFolder = parentMeta.mimeType === DRIVE_FOLDER_MIME_TYPE
      parents.push({
        uri: parentIsFolder
          ? driveFolderUrl(parentMeta.id)
          : driveFileUrl(parentMeta.id),
        name: parentMeta.name ?? 'Untitled folder',
        type: parentIsFolder
          ? NotebookStoreItemType.Folder
          : NotebookStoreItemType.File,
        children: [],
        remoteUri: parentIsFolder
          ? driveFolderUrl(parentMeta.id)
          : driveFileUrl(parentMeta.id),
        mimeType: parentMeta.mimeType,
        parents: [],
      })
    } catch (error) {
      console.error('Failed to fetch drive parent metadata', parentId, error)
    }
  }

  const parsedSize = meta.size ? Number(meta.size) : undefined
  const preflight: SharedNotebookPreflight = {
    fileId: meta.id,
    uri: item.uri,
    name: item.name,
    mimeType: meta.mimeType ?? '',
    parents,
    owners: Array.isArray(meta.owners) ? meta.owners : [],
    canDownload: meta.capabilities?.canDownload !== false,
    ...(meta.driveId ? { driveId: meta.driveId } : {}),
    ...(typeof meta.ownedByMe === 'boolean'
      ? { ownedByMe: meta.ownedByMe }
      : {}),
    ...(meta.modifiedTime ? { modifiedTime: meta.modifiedTime } : {}),
    ...(meta.version ? { version: String(meta.version) } : {}),
    ...(meta.headRevisionId ? { headRevisionId: meta.headRevisionId } : {}),
    ...(meta.md5Checksum ? { md5Checksum: meta.md5Checksum } : {}),
    ...(Number.isFinite(parsedSize) ? { sizeBytes: parsedSize } : {}),
    ...(meta.sharingUser ? { sharingUser: meta.sharingUser } : {}),
    ...(meta.lastModifyingUser
      ? { lastModifyingUser: meta.lastModifyingUser }
      : {}),
  }

  return { item, parents, preflight }
}

export async function fetchDriveItemWithParents(
  uri: string,
  ensureAccessToken: () => Promise<string>
): Promise<{ item: NotebookStoreItem; parents: NotebookStoreItem[] }> {
  const { item, parents } = await fetchSharedNotebookPreflight(
    uri,
    ensureAccessToken
  )
  return { item, parents }
}
