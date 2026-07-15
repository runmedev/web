import { create, fromJsonString, toJsonString } from '@bufbuild/protobuf'

import { getGoogleDriveBaseUrl } from '../lib/googleDriveRuntime'
import { parser_pb } from '../runme/client'
import {
  type ConflictResult,
  NotebookStoreItem,
  NotebookStoreItemType,
} from './notebook'

const GAPI_SCRIPT_SRC = 'https://apis.google.com/js/api.js'

// VERSION_FIELDS is the fields we want to return when fetching metadata to determine the file content version.
// https://developers.google.com/workspace/drive/api/guides/fields-parameter
const VERSION_FIELDS = 'md5Checksum,headRevisionId'
const NOTEBOOK_JSON_WRITE_OPTIONS = {
  emitDefaultValues: true,
} as unknown as Parameters<typeof toJsonString>[2]
const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder'

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
  parents?: string[]
  driveId?: string
  content?: string
  trashed?: boolean
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
    setToken: (token: { access_token: string }) => void
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
  create(doc: DriveDoc): Promise<DriveDoc>
  update(doc: DriveDoc): Promise<DriveDoc>
  move(
    fileId: string,
    sourceParentId: string,
    destinationParentId: string
  ): Promise<DriveDoc>
  get(
    request: Record<string, unknown>
  ): Promise<{ body?: string; result?: unknown }>
  getDrive(request: Record<string, unknown>): Promise<DriveGetResponse>
  list(request: Record<string, unknown>): Promise<DriveListResponse>
  listRevisions(
    request: Record<string, unknown>
  ): Promise<DriveRevisionListResponse>
  getRevision(
    request: Record<string, unknown>
  ): Promise<{ body?: string; result?: unknown }>
  listComments(
    request: Record<string, unknown>
  ): Promise<DriveCommentListResponse>
  createComment(request: {
    fileId: string
    resource: Record<string, unknown>
    fields?: string
  }): Promise<{ result?: unknown }>
  updateComment(request: {
    fileId: string
    commentId: string
    resource: Record<string, unknown>
    fields?: string
  }): Promise<{ result?: unknown }>
  createReply(request: {
    fileId: string
    commentId: string
    resource: Record<string, unknown>
    fields?: string
  }): Promise<{ result?: unknown }>
  ensureParent(file: DriveDoc, parentId?: string): Promise<DriveDoc>
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
  mentionedEmailAddresses?: string[]
  assigneeEmailAddress?: string
  replies?: DriveReply[]
}

type DriveCommentListResponse = {
  result?: {
    comments?: DriveComment[]
    nextPageToken?: string
  }
}

const DRIVE_COMMENT_FIELDS =
  'id,createdTime,modifiedTime,resolved,anchor,author(displayName,photoLink,me),deleted,htmlContent,content,replies(id,createdTime,modifiedTime,action,author(displayName,photoLink,me),deleted,htmlContent,content)'
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
    } = {}
  ): Promise<{ body?: string; result?: unknown }> {
    const token = this.gapi.client.getToken?.()?.access_token ?? ''
    if (!token) {
      throw new Error('Google Drive request requires an access token')
    }
    const response = await fetch(this.buildUrl(path, options.params), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body !== undefined
          ? {
              'Content-Type': options.contentType ?? 'application/json',
            }
          : {}),
      },
      body: options.body,
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '')
      throw new Error(
        `Drive request failed (${response.status} ${response.statusText}): ${errorBody}`
      )
    }

    if (options.expectText) {
      return { body: await response.text() }
    }

    const text = await response.text()
    if (!text) {
      return { result: undefined }
    }
    return { result: JSON.parse(text) }
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
    mimeType?: string
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

  private buildResource(doc: DriveDoc): Record<string, unknown> {
    const resource: Record<string, unknown> = {}
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
    return resource
  }

  async create(doc: DriveDoc): Promise<DriveDoc> {
    const resource = this.buildResource(doc)
    const response = (await this.files.create({
      resource,
      fields: 'id,name,mimeType,parents',
      supportsAllDrives: true,
    } as Record<string, unknown>)) as DriveCreateResponse
    const file = response.result ?? {}
    if (file.id && doc.content !== undefined) {
      console.log(`Setting content for new Drive file ${file.id}`)
      await this.setContent(file.id, doc.content, doc.mimeType)
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
      await this.setContent(file.id, doc.content, doc.mimeType)
    }

    return file
  }

  async move(
    fileId: string,
    sourceParentId: string,
    destinationParentId: string
  ): Promise<DriveDoc> {
    const response = (await this.files.update({
      fileId,
      addParents: destinationParentId,
      removeParents: sourceParentId,
      supportsAllDrives: true,
      fields: 'id,name,mimeType,parents',
    } as Record<string, unknown>)) as DriveUpdateResponse
    return response.result ?? { id: fileId }
  }

  get(
    request: Record<string, unknown>
  ): Promise<{ body?: string; result?: unknown }> {
    return this.files.get(request as any) as Promise<{
      body?: string
      result?: unknown
    }>
  }

  list(request: Record<string, unknown>): Promise<DriveListResponse> {
    return this.files.list(request as any) as Promise<DriveListResponse>
  }

  getDrive(request: Record<string, unknown>): Promise<DriveGetResponse> {
    return this.drives.get(request as any) as Promise<DriveGetResponse>
  }

  listRevisions(
    request: Record<string, unknown>
  ): Promise<DriveRevisionListResponse> {
    return this.revisions.list(
      request as any
    ) as Promise<DriveRevisionListResponse>
  }

  getRevision(
    request: Record<string, unknown>
  ): Promise<{ body?: string; result?: unknown }> {
    return this.revisions.get(request as any) as Promise<{
      body?: string
      result?: unknown
    }>
  }

  listComments(
    request: Record<string, unknown>
  ): Promise<DriveCommentListResponse> {
    const fileId = String(request.fileId ?? '')
    const params = { ...request }
    delete params.fileId
    return this.request(
      'GET',
      `/drive/v3/files/${encodeURIComponent(fileId)}/comments`,
      { params }
    ) as Promise<DriveCommentListResponse>
  }

  createComment(request: {
    fileId: string
    resource: Record<string, unknown>
    fields?: string
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
      }
    )
  }

  updateComment(request: {
    fileId: string
    commentId: string
    resource: Record<string, unknown>
    fields?: string
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
      }
    )
  }

  createReply(request: {
    fileId: string
    commentId: string
    resource: Record<string, unknown>
    fields?: string
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
      }
    )
  }

  async ensureParent(file: DriveDoc, parentId?: string): Promise<DriveDoc> {
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
    const response = (await this.files.update(request)) as DriveUpdateResponse
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
    } = {}
  ): Promise<{ body?: string; result?: unknown }> {
    const response = await fetch(this.buildUrl(path, options.params), {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        ...(options.body !== undefined
          ? {
              'Content-Type': options.contentType ?? 'application/json',
            }
          : {}),
      },
      body: options.body,
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '')
      throw new Error(
        `Drive request failed (${response.status} ${response.statusText}): ${errorBody}`
      )
    }

    if (options.expectText) {
      return { body: await response.text() }
    }

    const text = await response.text()
    if (!text) {
      return { result: undefined }
    }
    return { result: JSON.parse(text) }
  }

  private buildResource(doc: DriveDoc): Record<string, unknown> {
    const resource: Record<string, unknown> = {}
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
    return resource
  }

  private async setContent(
    fileId: string,
    content: string,
    mimeType?: string
  ): Promise<void> {
    await this.request(
      'PATCH',
      `/upload/drive/v3/files/${encodeURIComponent(fileId)}`,
      {
        params: {
          uploadType: 'media',
          supportsAllDrives: 'true',
        },
        body: content,
        contentType: mimeType ?? 'application/octet-stream',
      }
    )
  }

  async create(doc: DriveDoc): Promise<DriveDoc> {
    const response = await this.request('POST', '/drive/v3/files', {
      params: {
        fields: 'id,name,mimeType,parents',
        supportsAllDrives: 'true',
      },
      body: JSON.stringify(this.buildResource(doc)),
    })
    const file = (response.result ?? {}) as DriveDoc
    if (file.id && doc.content !== undefined) {
      await this.setContent(file.id, doc.content, doc.mimeType)
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
          },
          body: JSON.stringify(resource),
        }
      )
      file = (response.result ?? {}) as DriveDoc
    }

    if (doc.content !== undefined) {
      await this.setContent(doc.id, doc.content, doc.mimeType)
    }

    return file.id ? file : { ...doc }
  }

  async move(
    fileId: string,
    sourceParentId: string,
    destinationParentId: string
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
        },
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

  list(request: Record<string, unknown>): Promise<DriveListResponse> {
    return this.request('GET', '/drive/v3/files', {
      params: request,
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
    request: Record<string, unknown>
  ): Promise<DriveRevisionListResponse> {
    const fileId = String(request.fileId ?? '')
    return this.request(
      'GET',
      `/drive/v3/files/${encodeURIComponent(fileId)}/revisions`,
      { params: request }
    ) as Promise<DriveRevisionListResponse>
  }

  getRevision(
    request: Record<string, unknown>
  ): Promise<{ body?: string; result?: unknown }> {
    const fileId = String(request.fileId ?? '')
    const revisionId = String(request.revisionId ?? '')
    return this.request(
      'GET',
      `/drive/v3/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}`,
      {
        params: request,
        expectText: request.alt === 'media',
      }
    )
  }

  listComments(
    request: Record<string, unknown>
  ): Promise<DriveCommentListResponse> {
    const fileId = String(request.fileId ?? '')
    const params = { ...request }
    delete params.fileId
    return this.request(
      'GET',
      `/drive/v3/files/${encodeURIComponent(fileId)}/comments`,
      { params }
    ) as Promise<DriveCommentListResponse>
  }

  createComment(request: {
    fileId: string
    resource: Record<string, unknown>
    fields?: string
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
      }
    )
  }

  updateComment(request: {
    fileId: string
    commentId: string
    resource: Record<string, unknown>
    fields?: string
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
      }
    )
  }

  createReply(request: {
    fileId: string
    commentId: string
    resource: Record<string, unknown>
    fields?: string
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
      }
    )
  }

  async ensureParent(file: DriveDoc, parentId?: string): Promise<DriveDoc> {
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

export function driveFileUrl(id: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`
}

export function driveFolderUrl(id: string): string {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`
}

export interface DriveItem {
  id: string
  type: NotebookStoreItemType
}

type DriveFileMetadata = {
  id?: string
  name?: string
  mimeType?: string
  parents?: string[]
}

export interface DriveVersionMetadata {
  md5Checksum?: string
  headRevisionId?: string
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
  return { id, type }
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

export class DriveNotebookStore {
  // ensureAccessToken is injected because it comes from the GoogleAuthContext
  constructor(private readonly ensureAccessToken: () => Promise<string>) {}

  private readonly lastReadVersion = new Map<string, string>()

  private async getFilesClient(): Promise<DriveFilesClient> {
    const token = await this.ensureAccessToken()
    return ensureDriveFilesClient(token)
  }

  async create(parentUri: string, name: string): Promise<NotebookStoreItem> {
    const { id, type } = parseDriveItem(parentUri)
    if (type !== NotebookStoreItemType.Folder) {
      throw new Error('DriveNotebookStore.create expects a folder URI')
    }
    const client = await this.getFilesClient()
    let file = await client.create({
      name,
      mimeType: 'application/json',
      parents: [id],
      content: createInitialNotebookJson(),
    })

    if (!file.id) {
      throw new Error('Failed to create Google Drive notebook file')
    }
    const fileId = file.id
    file = await client.ensureParent(file, id)
    const isFolder = file.mimeType === DRIVE_FOLDER_MIME_TYPE
    return {
      uri: isFolder ? driveFolderUrl(fileId) : driveFileUrl(fileId),
      name: file.name ?? name,
      type: isFolder
        ? NotebookStoreItemType.Folder
        : NotebookStoreItemType.File,
      children: [],
      remoteUri: isFolder ? driveFolderUrl(fileId) : driveFileUrl(fileId),
      mimeType: file.mimeType ?? 'application/json',
      parents: [parentUri],
    }
  }

  async createContent(
    parentUri: string,
    name: string,
    content: string,
    mimeType: string = 'application/octet-stream'
  ): Promise<NotebookStoreItem> {
    const { id, type } = parseDriveItem(parentUri)
    if (type !== NotebookStoreItemType.Folder) {
      throw new Error('DriveNotebookStore.createContent expects a folder URI')
    }
    const client = await this.getFilesClient()
    let file = await client.create({
      name,
      mimeType,
      parents: [id],
      content,
    })

    if (!file.id) {
      throw new Error('Failed to create Google Drive file')
    }
    const fileId = file.id
    file = await client.ensureParent(file, id)
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

  async createFolder(
    parentUri: string,
    name: string
  ): Promise<NotebookStoreItem> {
    const { id, type } = parseDriveItem(parentUri)
    if (type !== NotebookStoreItemType.Folder) {
      throw new Error('DriveNotebookStore.createFolder expects a folder URI')
    }
    const client = await this.getFilesClient()
    let folder = await client.create({
      name,
      mimeType: DRIVE_FOLDER_MIME_TYPE,
      parents: [id],
    })

    if (!folder.id) {
      throw new Error('Failed to create Google Drive folder')
    }
    const folderId = folder.id
    folder = await client.ensureParent(folder, id)
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
    const { id, type } = parseDriveItem(uri)
    if (type !== NotebookStoreItemType.File) {
      throw new Error('DriveNotebookStore.save expects a file URI')
    }
    const client = await this.getFilesClient()
    const metadataResponse = await client.get({
      fileId: id,
      supportsAllDrives: true,
      //fields: "md5Checksum",
      fields: VERSION_FIELDS,
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
    })
    const updatedMetadataResponse = await client.get({
      fileId: id,
      supportsAllDrives: true,
      fields: VERSION_FIELDS,
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
    const { id, type } = parseDriveItem(uri)
    if (type !== NotebookStoreItemType.File) {
      throw new Error('DriveNotebookStore.load expects a file URI')
    }
    const client = await this.getFilesClient()
    const metadataResponse = await client.get({
      fileId: id,
      supportsAllDrives: true,
      fields: VERSION_FIELDS,
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
    })

    const body = extractBody(response)

    return fromJsonString(parser_pb.NotebookSchema, body, {
      ignoreUnknownFields: true,
    })
  }

  async list(uri: string): Promise<NotebookStoreItem[]> {
    const { id, type } = parseDriveItem(uri)
    if (type !== NotebookStoreItemType.Folder) {
      throw new Error(
        'Google Drive URI must reference a folder to list contents'
      )
    }
    const response = await this.search({
      q: `'${id}' in parents and trashed = false`,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      orderBy: 'name',
      fields: 'files(id,name,mimeType)',
    })

    const files = response.files.filter(
      (file): file is DriveSearchFile & { id: string } => Boolean(file?.id)
    )

    return files.map((file) => {
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
        parents: [],
      }
    })
  }

  /**
   * Runs a Google Drive files.list request without narrowing its query surface.
   * The request is forwarded as-is so callers can use the complete Drive `q`
   * grammar and list parameters. Returned files retain their Drive metadata and
   * gain a Runme-compatible URI when the response includes an id and MIME type.
   */
  async search(request: Record<string, unknown>): Promise<DriveSearchResult> {
    const client = await this.getFilesClient()
    const response = await client.list(request)
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
          uri: isFolder ? driveFolderUrl(file.id) : driveFileUrl(file.id),
        }
      }),
    }
  }

  async listComments(uri: string): Promise<DriveComment[]> {
    const { id, type } = parseDriveItem(uri)
    if (type !== NotebookStoreItemType.File) {
      throw new Error('DriveNotebookStore.listComments expects a file URI')
    }
    const client = await this.getFilesClient()
    const comments: DriveComment[] = []
    let pageToken: string | undefined

    do {
      const response = await client.listComments({
        fileId: id,
        supportsAllDrives: true,
        includeDeleted: false,
        fields: DRIVE_COMMENT_LIST_FIELDS,
        ...(pageToken ? { pageToken } : {}),
      })
      comments.push(...(response.result?.comments ?? []))
      pageToken = optionalString(response.result?.nextPageToken)
    } while (pageToken)

    return comments
  }

  async createComment(
    uri: string,
    content: string,
    anchor?: string
  ): Promise<DriveComment> {
    const { id, type } = parseDriveItem(uri)
    if (type !== NotebookStoreItemType.File) {
      throw new Error('DriveNotebookStore.createComment expects a file URI')
    }
    const trimmedContent = content.trim()
    if (!trimmedContent) {
      throw new Error('DriveNotebookStore.createComment requires content')
    }
    const client = await this.getFilesClient()
    const response = await client.createComment({
      fileId: id,
      resource: {
        content: trimmedContent,
        ...(anchor ? { anchor } : {}),
      },
      fields: DRIVE_COMMENT_FIELDS,
    })
    return (response.result ?? {}) as DriveComment
  }

  async replyToComment(
    uri: string,
    commentId: string,
    content: string
  ): Promise<DriveReply> {
    const { id, type } = parseDriveItem(uri)
    if (type !== NotebookStoreItemType.File) {
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
      fileId: id,
      commentId: commentId.trim(),
      resource: {
        content: trimmedContent,
      },
    })
    return (response.result ?? {}) as DriveReply
  }

  async resolveComment(uri: string, commentId: string): Promise<DriveReply> {
    const { id, type } = parseDriveItem(uri)
    if (type !== NotebookStoreItemType.File) {
      throw new Error('DriveNotebookStore.resolveComment expects a file URI')
    }
    if (!commentId.trim()) {
      throw new Error('DriveNotebookStore.resolveComment requires a comment id')
    }
    const client = await this.getFilesClient()
    const response = await client.createReply({
      fileId: id,
      commentId: commentId.trim(),
      resource: {
        action: 'resolve',
      },
    })
    return (response.result ?? {}) as DriveReply
  }

  async reopenComment(uri: string, commentId: string): Promise<DriveReply> {
    const { id, type } = parseDriveItem(uri)
    if (type !== NotebookStoreItemType.File) {
      throw new Error('DriveNotebookStore.reopenComment expects a file URI')
    }
    if (!commentId.trim()) {
      throw new Error('DriveNotebookStore.reopenComment requires a comment id')
    }
    const client = await this.getFilesClient()
    const response = await client.createReply({
      fileId: id,
      commentId: commentId.trim(),
      resource: {
        action: 'reopen',
      },
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
    const { id, type } = parseDriveItem(uri)
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
    const { id, type } = parseDriveItem(uri)
    if (type !== NotebookStoreItemType.File) {
      throw new Error('DriveNotebookStore.listRevisions expects a file URI')
    }
    const client = await this.getFilesClient()
    const revisions: DriveRevision[] = []
    let pageToken: string | undefined

    do {
      const response = await client.listRevisions({
        fileId: id,
        supportsAllDrives: true,
        fields:
          'nextPageToken,revisions(id,mimeType,modifiedTime,md5Checksum,size,keepForever,lastModifyingUser(displayName,emailAddress))',
        ...(pageToken ? { pageToken } : {}),
      })
      revisions.push(...(response.result?.revisions ?? []))
      pageToken = optionalString(response.result?.nextPageToken)
    } while (pageToken)

    return revisions.map(normalizeDriveRevision)
  }

  async loadRevision(
    uri: string,
    revisionId: string
  ): Promise<parser_pb.Notebook> {
    const { id, type } = parseDriveItem(uri)
    if (type !== NotebookStoreItemType.File) {
      throw new Error('DriveNotebookStore.loadRevision expects a file URI')
    }
    if (!revisionId?.trim()) {
      throw new Error('DriveNotebookStore.loadRevision requires a revision id')
    }
    const client = await this.getFilesClient()
    const response = await client.getRevision({
      fileId: id,
      revisionId: revisionId.trim(),
      supportsAllDrives: true,
      alt: 'media',
    })
    const body = extractBody(response)
    return fromJsonString(parser_pb.NotebookSchema, body, {
      ignoreUnknownFields: true,
    })
  }

  async rename(uri: string, name: string): Promise<NotebookStoreItem> {
    const { id, type } = parseDriveItem(uri)
    if (
      type !== NotebookStoreItemType.File &&
      type !== NotebookStoreItemType.Folder
    ) {
      throw new Error('DriveNotebookStore.rename expects a file or folder URI')
    }
    const client = await this.getFilesClient()
    const file = await client.update({
      id,
      name,
    })

    const fileId = file.id ?? id
    const mimeType = file.mimeType
    const isFolder = mimeType === DRIVE_FOLDER_MIME_TYPE
    return {
      uri: isFolder ? driveFolderUrl(fileId) : driveFileUrl(fileId),
      name: file.name ?? name,
      type: isFolder
        ? NotebookStoreItemType.Folder
        : NotebookStoreItemType.File,
      children: [],
      remoteUri: isFolder ? driveFolderUrl(fileId) : driveFileUrl(fileId),
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
      throw new Error('DriveNotebookStore.move expects a new destination folder')
    }

    const client = await this.getFilesClient()
    const file = await client.move(
      item.id,
      sourceParent.id,
      destinationParent.id
    )
    const fileId = file.id ?? item.id
    const isFolder =
      file.mimeType === DRIVE_FOLDER_MIME_TYPE ||
      item.type === NotebookStoreItemType.Folder
    const itemUri = isFolder ? driveFolderUrl(fileId) : driveFileUrl(fileId)
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
    const { id, type } = parseDriveItem(uri)
    if (type !== NotebookStoreItemType.File) {
      throw new Error('DriveNotebookStore.moveToTrash expects a file URI')
    }
    const client = await this.getFilesClient()
    const file = await client.update({
      id,
      trashed: true,
    })

    const fileId = file.id ?? id
    return {
      uri: driveFileUrl(fileId),
      name: file.name ?? uri,
      type: NotebookStoreItemType.File,
      children: [],
      remoteUri: driveFileUrl(fileId),
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
    const { id, type } = parseDriveItem(uri)
    if (type !== NotebookStoreItemType.File) {
      throw new Error('DriveNotebookStore.saveContent expects a file URI')
    }
    const client = await this.getFilesClient()
    await client.update({
      id,
      mimeType,
      content,
    })
  }

  async loadContent(uri: string): Promise<string> {
    const { id, type } = parseDriveItem(uri)
    if (type !== NotebookStoreItemType.File) {
      throw new Error('DriveNotebookStore.loadContent expects a file URI')
    }
    const client = await this.getFilesClient()
    const response = await client.get({
      fileId: id,
      supportsAllDrives: true,
      alt: 'media',
    })
    return extractBody(response)
  }

  async getMetadata(uri: string): Promise<NotebookStoreItem | null> {
    const { id, type } = parseDriveItem(uri)
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
      fields: 'id,name,mimeType,parents,driveId',
    })
    const result = response.result as {
      name?: string
      mimeType?: string
      parents?: string[]
      driveId?: string
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
}

export async function fetchDriveItemWithParents(
  uri: string,
  ensureAccessToken: () => Promise<string>
): Promise<{ item: NotebookStoreItem; parents: NotebookStoreItem[] }> {
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
    fields: 'id,name,mimeType,parents',
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

  return { item, parents }
}
