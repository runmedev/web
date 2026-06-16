import { create } from '@bufbuild/protobuf'
import { jwtDecode } from 'jwt-decode'

import { OidcConfig, oidcConfigManager } from '../../auth/oidcConfig'
import { parser_pb } from '../../runme/client'
import {
  driveFileUrl,
  driveFolderUrl,
  isDriveItemUri,
  parseDriveItem,
} from '../../storage/drive'
import {
  FilesystemNotebookStore,
  isFileSystemAccessSupported,
} from '../../storage/fs'
import { LOCAL_FOLDER_URI } from '../../storage/local'
import { NotebookStoreItemType } from '../../storage/notebook'
import { getAuthData } from '../../token'
import { agentEndpointManager } from '../agentEndpointManager'
import { aisreClientManager } from '../aisreClientManager'
import {
  disableAppConfigOverridesOnLoad,
  enableAppConfigOverridesOnLoad,
  getDefaultAppConfigUrl,
  isLocalConfigPreferredOnLoad,
  setAppConfig,
  setAppConfigFromYaml,
  setLocalConfigPreferredOnLoad,
} from '../appConfig'
import { driveLinkCoordinator } from '../driveLinkCoordinator'
import {
  copyDriveNotebookFile,
  createDriveFile,
  listDriveFolderItems,
  moveDriveFileToTrash,
  saveNotebookAsDriveCopy,
  updateDriveFileBytes,
} from '../driveTransfer'
import { googleClientManager } from '../googleClientManager'
import {
  deserializeMarkdownToNotebook,
  getImportedFileBytes,
  getImportedFileName,
  getPickedMarkdownSelection,
  pickMarkdownSource,
  registerImportedMarkdownForUri,
  toImportedNotebookName,
} from '../markdownImport'
import { createNotebookDiffRuntimeApi } from '../notebookDiff/runtime'
import type { Runner } from '../runner'
import {
  buildNotebookMarkdownLink,
  buildNotebookShareUrl,
  getNotebookShareTarget,
  normalizeNotebookReferenceUri,
} from '../shareLinks'
import { getClaimedSessionId } from '../tabIdentity'
import { appState } from './AppState'
import type {
  AppKernelNetworkApi,
  AppKernelOpfsApi,
} from './appKernelLowLevelApis'
import {
  type CodexProject,
  getCodexProjectManager,
} from './codexProjectManager'
import { getCodexTurnEvents, listCodexTurns } from './codexTurns'
import { type HarnessAdapter, getHarnessManager } from './harnessManager'
import { getHarnessRuntimeManager } from './harnessRuntimeManager'
import { getJupyterManager } from './jupyterManager'
import { responsesDirectConfigManager } from './responsesDirectConfigManager'
import {
  type NotebookDataLike,
  type RunmeConsoleApi,
  createNotebooksApi,
} from './runmeConsole'
import { getRunnersManager } from './runnersManager'

type SendOutput = (data: string) => void

type RuntimeNotebookStore = {
  create: (parentUri: string, name: string) => Promise<{ uri: string }>
  save: (uri: string, notebook: parser_pb.Notebook) => Promise<unknown>
}

type WorkspaceApi = {
  getItems?: () => string[]
  addItem?: (uri: string) => void
  removeItem?: (uri: string) => void
}

type NotebookReferenceInfo = {
  input?: string
  uri: string
  localUri?: string
  remoteUri?: string
  googleDriveUrl?: string
  shareTarget: string
  shareUrl: string
  markdownLink: string
  title: string
  name: string
  source: 'local' | 'fs' | 'drive' | 'unknown'
}

type DocumentContent = {
  uri: string
  requestedUri?: string
  name: string
  mimeType?: string
  content: string
  syncStatus?: string
  version?: {
    checksum?: string
    revisionId?: string
    modifiedTime?: string
  }
}

type DocumentUpdateResult = Omit<DocumentContent, 'content'>

type RunnerSync = {
  onUpdated?: (runner: Runner) => void
  onDeleted?: (name: string) => void
  onDefaultSet?: (name: string) => void
}

type EnsureAccessToken = (options?: {
  interactive?: boolean
}) => Promise<string>

type LocalTextSelection = {
  name: string
  text: string
}

type LocalServiceAccountKeyResponse = {
  name?: string
  path?: string
  text?: string
}

const LOCAL_SERVICE_ACCOUNT_KEY_ENDPOINT = '/__runme-dev/service-account-key'

function emitLine(sendOutput: SendOutput | undefined, message: string): void {
  sendOutput?.(`${message}\r\n`)
}

async function readTextFile(file: File): Promise<LocalTextSelection> {
  if (typeof file.text === 'function') {
    return {
      name: file.name || 'selected.json',
      text: await file.text(),
    }
  }
  if (typeof file.arrayBuffer === 'function') {
    const buffer = await file.arrayBuffer()
    return {
      name: file.name || 'selected.json',
      text: new TextDecoder().decode(new Uint8Array(buffer)),
    }
  }
  throw new Error('Selected file does not support text or arrayBuffer reads')
}

async function pickJsonFromLocalFilesystem(): Promise<LocalTextSelection | null> {
  if (
    typeof window !== 'undefined' &&
    typeof window.showOpenFilePicker === 'function'
  ) {
    try {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        excludeAcceptAllOption: false,
        types: [
          {
            description: 'JSON files',
            accept: {
              'application/json': ['.json'],
              'text/plain': ['.json'],
            },
          },
        ],
      })
      if (!handle) {
        return null
      }
      return readTextFile(await handle.getFile())
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return null
      }
      throw error
    }
  }

  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.style.display = 'none'

    input.onchange = async () => {
      const file = input.files?.[0] ?? null
      input.remove()
      if (!file) {
        resolve(null)
        return
      }
      try {
        resolve(await readTextFile(file))
      } catch (error) {
        reject(error)
      }
    }

    input.oncancel = () => {
      input.remove()
      resolve(null)
    }

    document.body.appendChild(input)
    input.click()
  })
}

async function readServiceAccountJsonFromLocalPath(
  keyPath: string
): Promise<LocalTextSelection> {
  const trimmedPath = keyPath.trim()
  if (!trimmedPath) {
    throw new Error('Service account key path is required.')
  }

  const url = new URL(
    LOCAL_SERVICE_ACCOUNT_KEY_ENDPOINT,
    window.location.origin
  )
  url.searchParams.set('path', trimmedPath)
  const response = await fetch(url.toString())
  const responseText = await response.text()
  if (!response.ok) {
    throw new Error(
      `Failed to read service account key from local dev server (${response.status}): ${responseText}`
    )
  }

  const parsed = JSON.parse(responseText) as LocalServiceAccountKeyResponse
  if (!parsed.text) {
    throw new Error(
      'Local dev server did not return service account JSON text.'
    )
  }
  return {
    name: parsed.name || trimmedPath.split('/').pop() || 'service-account.json',
    text: parsed.text,
  }
}

function createRunmeApi(
  runme: RunmeConsoleApi,
  sendOutput: SendOutput | undefined
): RunmeConsoleApi {
  return {
    getCurrentNotebook: () => runme.getCurrentNotebook(),
    clear: (target?: unknown) => {
      const message = runme.clear(target)
      emitLine(sendOutput, message)
      return message
    },
    clearOutputs: (target?: unknown) => {
      const message = runme.clearOutputs(target)
      emitLine(sendOutput, message)
      return message
    },
    runAll: (target?: unknown) => {
      const message = runme.runAll(target)
      emitLine(sendOutput, message)
      return message
    },
    rerun: (target?: unknown) => {
      const message = runme.rerun(target)
      emitLine(sendOutput, message)
      return message
    },
    help: () => {
      const message = runme.help()
      emitLine(sendOutput, message)
      return message
    },
  }
}

function createEmptyNotebook(): parser_pb.Notebook {
  return create(parser_pb.NotebookSchema, { cells: [], metadata: {} })
}

function defaultEnsureFilesystemStore(): FilesystemNotebookStore | null {
  if (appState.filesystemStore) {
    return appState.filesystemStore
  }
  if (!isFileSystemAccessSupported()) {
    return null
  }
  const store = new FilesystemNotebookStore()
  appState.setFilesystemStore(store)
  return store
}

function canonicalizeDriveUri(uri: string): string | null {
  if (!isDriveItemUri(uri)) {
    return null
  }
  const item = parseDriveItem(uri)
  return item.type === NotebookStoreItemType.Folder
    ? driveFolderUrl(item.id)
    : driveFileUrl(item.id)
}

function deriveTitleFromUri(uri: string): string {
  try {
    const parsed = new URL(uri)
    const segments = parsed.pathname.split('/').filter(Boolean)
    const tail = segments[segments.length - 1]
    if (tail) {
      return decodeURIComponent(tail)
    }
  } catch {
    // Fall through to the URI segment heuristic.
  }

  const segments = uri.split('/').filter(Boolean)
  return segments[segments.length - 1] || 'Untitled'
}

export function createAppJsGlobals({
  runme,
  sendOutput,
  resolveNotebookStore,
  ensureFilesystemStore = defaultEnsureFilesystemStore,
  workspace,
  openNotebook,
  runnerSync,
  resolveNotebook,
  listNotebooks,
  ensureAccessToken,
  opfsApi,
  networkApi,
}: {
  runme: RunmeConsoleApi
  sendOutput?: SendOutput
  resolveNotebookStore?: () => RuntimeNotebookStore | null
  ensureFilesystemStore?: () => FilesystemNotebookStore | null
  workspace?: WorkspaceApi
  openNotebook?: (uri: string) => void | Promise<void>
  runnerSync?: RunnerSync
  resolveNotebook?: (target?: unknown) => NotebookDataLike | null
  listNotebooks?: () => NotebookDataLike[]
  ensureAccessToken?: EnsureAccessToken
  opfsApi?: AppKernelOpfsApi
  networkApi?: AppKernelNetworkApi
}) {
  const getWorkspaceItems = () =>
    workspace?.getItems?.() ?? appState.getWorkspaceItems()
  const addWorkspaceItem = (uri: string) => {
    if (workspace?.addItem) {
      workspace.addItem(uri)
      return
    }
    appState.addWorkspaceItem(uri)
  }
  const removeWorkspaceItem = (uri: string) => {
    if (workspace?.removeItem) {
      workspace.removeItem(uri)
      return
    }
    appState.removeWorkspaceItem(uri)
  }
  const resolveStore = () => resolveNotebookStore?.() ?? appState.localNotebooks
  const openNotebookForRuntime = async (uri: string) => {
    if (openNotebook) {
      await openNotebook(uri)
      return
    }
    await appState.openNotebook(uri)
  }
  const resolveLocalMirrorStore = () => {
    if (!appState.localNotebooks) {
      throw new Error('Local notebook mirror store is not initialized yet.')
    }
    return appState.localNotebooks
  }
  const startGoogleDriveOAuthForRuntime = async (options?: {
    mode?: 'popup' | 'redirect' | 'new_tab'
    prompt?: 'none' | 'consent'
  }) => {
    const result = await appState.startGoogleDriveOAuth(options)
    const safeResult = {
      status: result.status,
      authFlow: result.authFlow,
      mode: result.mode,
      ...(result.accessToken ? { accessToken: '<redacted>' } : {}),
    }
    emitLine(
      sendOutput,
      result.status === 'authorized'
        ? 'Google Drive OAuth authorized.'
        : `Google Drive OAuth flow started (${result.mode}).`
    )
    return safeResult
  }

  const runmeApi = createRunmeApi(runme, sendOutput)
  const notebooksApi = createNotebooksApi({
    resolveNotebook: resolveNotebook ?? (() => runme.getCurrentNotebook()),
    listNotebooks,
  })
  const notebookDiffApi = createNotebookDiffRuntimeApi({
    notebooksApi,
    resolveLocalNotebooks: () => appState.localNotebooks,
    resolveDriveNotebookStore: () => appState.driveNotebookStore,
    resolveNotebook: resolveNotebook ?? (() => runme.getCurrentNotebook()),
  })
  const jupyterManager = getJupyterManager()
  const harnessManager = getHarnessManager()
  const harnessRuntimeManager = getHarnessRuntimeManager()
  const codexProjectManager = getCodexProjectManager()
  const responsesDirect = responsesDirectConfigManager
  const codexTurnsHelp = [
    'codex.turns.list()                       - List recorded Codex turns from the local browser journal',
    'codex.turns.getEvents(turnId, options?) - Return journal rows for a given turn id',
    '  options.sessionId                      - Optional session filter when turn ids must be disambiguated',
    '  Example: const [latest] = await codex.turns.list(); console.log(await codex.turns.getEvents(latest.turnId));',
    'codex.turns.help()                      - Show this help',
  ].join('\n')
  const codexProjectApi = {
    list: () => {
      const projects = codexProjectManager.list()
      if (projects.length === 0) {
        const message = 'No codex projects configured.'
        emitLine(sendOutput, message)
        return message
      }
      const defaultProjectId = codexProjectManager.getDefaultId()
      const message = projects
        .map((project) => {
          const isDefault = project.id === defaultProjectId
          return `${project.id}: ${project.name} (${project.cwd}, model=${project.model}, sandbox=${project.sandboxPolicy}, approval=${project.approvalPolicy})${
            isDefault ? ' (default)' : ''
          }`
        })
        .join('\n')
      emitLine(sendOutput, message)
      return message
    },
    create: (
      name: string,
      cwd: string,
      model: string,
      sandboxPolicy: string,
      approvalPolicy: string,
      personality: string
    ) => {
      const created = codexProjectManager.create(
        name,
        cwd,
        model,
        sandboxPolicy,
        approvalPolicy,
        personality
      )
      const message = `Codex project ${created.name} created (${created.id})`
      emitLine(sendOutput, message)
      return message
    },
    update: (id: string, patch: Partial<CodexProject>) => {
      const updated = codexProjectManager.update(id, patch)
      const message = `Codex project ${updated.name} updated (${updated.id})`
      emitLine(sendOutput, message)
      return message
    },
    delete: (id: string) => {
      codexProjectManager.delete(id)
      const message = `Codex project ${id} deleted`
      emitLine(sendOutput, message)
      return message
    },
    getDefault: () => {
      const project = codexProjectManager.getDefault()
      const message = `Default codex project: ${project.name} (${project.id}, cwd=${project.cwd}, model=${project.model})`
      emitLine(sendOutput, message)
      return message
    },
    setDefault: (id: string) => {
      codexProjectManager.setDefault(id)
      const message = `Default codex project set to ${id}`
      emitLine(sendOutput, message)
      return message
    },
  }
  const codexTurnsApi = {
    list: async () => await listCodexTurns(),
    getEvents: async (
      turnId: string,
      options?: {
        sessionId?: string
      }
    ) => await getCodexTurnEvents(String(turnId ?? ''), options),
    help: () => {
      emitLine(sendOutput, codexTurnsHelp)
      return codexTurnsHelp
    },
  }
  const codexApi = {
    help: () => {
      const message = [
        'codex.project.* - Manage configured Codex projects',
        codexTurnsHelp,
      ].join('\n')
      emitLine(sendOutput, message)
      return message
    },
    project: codexProjectApi,
    turns: codexTurnsApi,
  }

  const normalizeHarnessAdapter = (
    value: string
  ): { adapter: HarnessAdapter; warning?: string } => {
    const normalized = (value ?? '').trim().toLowerCase()
    if (normalized === 'codex') {
      return { adapter: 'codex' }
    }
    if (
      normalized === 'codex-wasm' ||
      normalized === 'codex_wasm' ||
      normalized === 'codexwasm'
    ) {
      return { adapter: 'codex-wasm' }
    }
    if (normalized === 'responses' || normalized === 'response') {
      return {
        adapter: 'responses-direct',
        warning: `Harness adapter "${value}" is deprecated; using "responses-direct" instead.`,
      }
    }
    if (
      normalized === 'responses-direct' ||
      normalized === 'responses_direct' ||
      normalized === 'responsesdirect'
    ) {
      return { adapter: 'responses-direct' }
    }
    throw new Error(`Unsupported harness adapter: ${String(value)}`)
  }

  const formatHarness = (
    harness: { name: string; baseUrl: string; adapter: HarnessAdapter },
    options?: { includeDefaultMarker?: boolean }
  ): string => {
    const isDefault =
      options?.includeDefaultMarker === true &&
      harness.name === harnessManager.getDefaultName()
    return `${harness.name}: ${harness.baseUrl} (${harness.adapter})${
      isDefault ? ' (default)' : ''
    }`
  }

  const formatDefaultHarness = (harness: {
    name: string
    baseUrl: string
    adapter: HarnessAdapter
  }): string => {
    return `Default harness: ${harness.name} (${harness.baseUrl}, ${harness.adapter})`
  }

  const parseVectorStores = (value: string[] | string): string[] => {
    if (Array.isArray(value)) {
      return value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry): entry is string => entry.length > 0)
    }
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    }
    return []
  }

  const openWorkspaceAndAdd = () => {
    const store = ensureFilesystemStore()
    if (!store) {
      const message = 'File System Access API is not supported in this browser.'
      emitLine(sendOutput, message)
      return message
    }

    void store
      .openWorkspace()
      .then((workspaceRootUri) => {
        if (!getWorkspaceItems().includes(workspaceRootUri)) {
          addWorkspaceItem(workspaceRootUri)
        }
        emitLine(sendOutput, `Added local folder: ${workspaceRootUri}`)
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          emitLine(sendOutput, 'Picker cancelled.')
          return
        }
        emitLine(sendOutput, `Failed to open folder: ${String(error)}`)
      })

    return 'Opening directory picker...'
  }

  const importMarkdownAndOpen = async () => {
    const store = resolveStore()
    if (!store) {
      emitLine(sendOutput, 'Notebook store is not initialized yet.')
      return 'Notebook store unavailable.'
    }

    let picked
    try {
      picked = await pickMarkdownSource()
    } catch (error) {
      const message = `Failed to open markdown picker: ${String(error)}`
      emitLine(sendOutput, message)
      return message
    }

    if (!picked) {
      emitLine(sendOutput, 'Markdown import cancelled.')
      return 'Import cancelled.'
    }

    try {
      const selection = getPickedMarkdownSelection(picked.sourceUri)
      const notebook = await deserializeMarkdownToNotebook(selection)
      const fileName = toImportedNotebookName(picked.name)
      const created = await store.create(LOCAL_FOLDER_URI, fileName)
      await store.save(created.uri, notebook)
      if (!getWorkspaceItems().includes(LOCAL_FOLDER_URI)) {
        addWorkspaceItem(LOCAL_FOLDER_URI)
      }
      await openNotebookForRuntime(created.uri)
      const message = `Imported ${picked.name} as ${fileName}`
      emitLine(sendOutput, message)
      return message
    } catch (error) {
      const message = `Failed to import markdown file: ${String(error)}`
      emitLine(sendOutput, message)
      return message
    }
  }

  const createLocalNotebookAndOpen = async (
    name: string,
    folderUri: string = LOCAL_FOLDER_URI
  ) => {
    const trimmedName = name?.trim()
    if (!trimmedName) {
      throw new Error('Usage: notebooks.createLocal(name, options?)')
    }
    const store = resolveStore()
    if (!store) {
      throw new Error('Notebook store is not initialized yet.')
    }

    const created = await store.create(folderUri, trimmedName)
    await store.save(created.uri, createEmptyNotebook())

    if (!getWorkspaceItems().includes(folderUri)) {
      addWorkspaceItem(folderUri)
    }

    await openNotebookForRuntime(created.uri)
    return created.uri
  }

  const appendNotebookCell = async ({
    target,
    at,
    reason,
    execute,
    cell,
  }: {
    target?: { uri: string } | { handle: { uri: string; revision: string } }
    at?: { index: number } | { beforeRefId: string } | { afterRefId: string }
    reason?: string
    execute?: boolean
    cell: {
      kind: 'code' | 'markup'
      languageId?: string
      value?: string
      metadata?: Record<string, string>
    }
  }) => {
    const doc = await notebooksApi.get(target)
    const beforeRefIds = new Set(
      (doc.notebook.cells ?? []).map((item) => item.refId)
    )
    const updated = await notebooksApi.update({
      target: { handle: doc.handle },
      expectedRevision: doc.handle.revision,
      reason:
        reason ??
        `Append ${cell.kind === 'markup' ? 'markup' : 'code'} cell from App Console helper`,
      operations: [
        {
          op: 'insert',
          at: at ?? { index: -1 },
          cells: [cell],
        },
      ],
    })

    const inserted =
      (updated.notebook.cells ?? []).find(
        (item) => !beforeRefIds.has(item.refId)
      ) ?? null
    if (!inserted) {
      throw new Error('Failed to identify inserted notebook cell.')
    }

    if (execute) {
      const executed = await notebooksApi.execute({
        target: { handle: updated.handle },
        refIds: [inserted.refId],
      })
      const refreshed = await notebooksApi.get({ handle: executed.handle })
      const executedCell =
        (refreshed.notebook.cells ?? []).find(
          (item) => item.refId === inserted.refId
        ) ?? inserted
      return {
        handle: refreshed.handle,
        cell: executedCell,
      }
    }

    return {
      handle: updated.handle,
      cell: inserted,
    }
  }

  const resolveReferenceInput = (reference?: unknown): string => {
    if (reference === undefined || reference === null) {
      const current = runme.getCurrentNotebook()
      if (!current) {
        throw new Error(
          'Usage: notebooks.resolve(reference). No current notebook is available.'
        )
      }
      return current.getUri()
    }
    if (typeof reference === 'string') {
      return normalizeNotebookReferenceUri(reference)
    }
    if (
      typeof reference === 'object' &&
      'uri' in reference &&
      typeof reference.uri === 'string' &&
      reference.uri.trim()
    ) {
      return normalizeNotebookReferenceUri(reference.uri)
    }
    if (
      typeof reference === 'object' &&
      'handle' in reference &&
      reference.handle &&
      typeof (reference.handle as { uri?: unknown }).uri === 'string' &&
      (reference.handle as { uri: string }).uri.trim()
    ) {
      return normalizeNotebookReferenceUri(
        (reference.handle as { uri: string }).uri
      )
    }
    throw new Error(
      'Usage: notebooks.resolve(reference). Reference must be a local URI, Drive URL, Runme share URL, Markdown link, or notebook target.'
    )
  }

  const findOpenNotebook = (uri: string): NotebookDataLike | null => {
    const current = runme.getCurrentNotebook()
    if (current?.getUri() === uri) {
      return current
    }
    return (
      listNotebooks?.().find((notebook) => notebook.getUri() === uri) ?? null
    )
  }

  const findLocalRecordForRemote = async (remoteUri: string) => {
    const localStore = appState.localNotebooks
    if (!localStore) {
      return null
    }
    const canonicalRemoteUri = canonicalizeDriveUri(remoteUri) ?? remoteUri
    return (
      (await localStore.files
        .where('remoteId')
        .equals(canonicalRemoteUri)
        .first()) ??
      (canonicalRemoteUri === remoteUri
        ? null
        : await localStore.files.where('remoteId').equals(remoteUri).first())
    )
  }

  const resolveDocumentLocalUri = async (reference: string) => {
    const rawReference = String(reference ?? '').trim()
    if (!rawReference) {
      throw new Error('Usage: documents.get(uri). URI is required.')
    }
    const parsedUri = normalizeNotebookReferenceUri(rawReference)
    const driveUri = canonicalizeDriveUri(parsedUri)
    if (parsedUri.startsWith('local://file/')) {
      return {
        localUri: parsedUri,
        requestedUri: parsedUri === rawReference ? undefined : rawReference,
      }
    }
    if (driveUri) {
      const record = await findLocalRecordForRemote(driveUri)
      if (!record) {
        throw new Error(
          `Drive document ${driveUri} is not mirrored locally. Open it in Runme before using documents.get/update.`
        )
      }
      return {
        localUri: record.id,
        requestedUri: rawReference,
      }
    }
    throw new Error(
      `Unsupported document URI ${rawReference}. Expected local://file/<id> or a mirrored Google Drive file URL.`
    )
  }

  const buildDocumentContent = async (
    uri: string,
    requestedUri?: string,
    includeContent = true
  ): Promise<DocumentContent> => {
    const localStore = resolveLocalMirrorStore()
    const metadata = await localStore.getMetadata(uri)
    if (!metadata || metadata.type !== NotebookStoreItemType.File) {
      throw new Error(`Local document record not found for ${uri}`)
    }
    const record = await localStore.files.get(uri)
    if (!record) {
      throw new Error(`Local document record not found for ${uri}`)
    }
    const [content, syncState] = await Promise.all([
      includeContent ? localStore.loadContent(uri) : Promise.resolve(''),
      localStore.getSyncState(uri),
    ])
    const versionSource = syncState.lastUpstreamVersion ?? {}
    return {
      uri,
      ...(requestedUri && requestedUri !== uri ? { requestedUri } : {}),
      name: metadata.name || record.name,
      mimeType: metadata.mimeType ?? record.mimeType,
      content,
      syncStatus: syncState.status,
      version: {
        checksum: versionSource.checksum ?? record.md5Checksum,
        revisionId: versionSource.revisionId,
        modifiedTime: versionSource.modifiedTime,
      },
    }
  }

  const documentsHelpers = {
    get: async (uri: string): Promise<DocumentContent> => {
      const resolved = await resolveDocumentLocalUri(uri)
      return buildDocumentContent(resolved.localUri, resolved.requestedUri)
    },
    update: async (
      uri: string,
      content: string,
      options?: {
        mimeType?: string
        expectedVersion?: string
        flush?: boolean
      }
    ): Promise<DocumentUpdateResult> => {
      const resolved = await resolveDocumentLocalUri(uri)
      const localStore = resolveLocalMirrorStore()
      const current = await buildDocumentContent(
        resolved.localUri,
        resolved.requestedUri
      )
      const expectedVersion = options?.expectedVersion?.trim()
      if (expectedVersion) {
        const acceptedVersions = new Set(
          [
            current.version?.checksum,
            current.version?.revisionId,
          ].filter((item): item is string => !!item)
        )
        if (!acceptedVersions.has(expectedVersion)) {
          throw new Error(
            `Document version mismatch for ${resolved.localUri}: expected ${expectedVersion}, current ${current.version?.revisionId ?? current.version?.checksum ?? '<unknown>'}`
          )
        }
      }
      const mimeType =
        options?.mimeType?.trim() || current.mimeType || 'application/json'
      await localStore.saveContent(resolved.localUri, String(content), mimeType)
      if (options?.flush) {
        await localStore.sync(resolved.localUri)
      }
      const updated = await buildDocumentContent(
        resolved.localUri,
        resolved.requestedUri,
        false
      )
      const { content: _content, ...result } = updated
      return result
    },
    help: () => {
      return [
        'documents.get(uri)                         - Read raw document content from the local mirror',
        'documents.update(uri, content, options?)   - Write raw document content to the local mirror',
        '  options.mimeType                         - Preserve or set the content MIME type',
        '  options.expectedVersion                  - Optional optimistic checksum/revision guard',
        '  options.flush                            - Wait for the backing-store sync attempt',
      ].join('\n')
    },
  }

  const resolveNotebookReference = async (
    reference?: unknown
  ): Promise<NotebookReferenceInfo> => {
    const input = typeof reference === 'string' ? reference : undefined
    const parsedUri = resolveReferenceInput(reference)
    const driveUri = canonicalizeDriveUri(parsedUri)
    const uri = driveUri ?? parsedUri
    const localStore = appState.localNotebooks
    const openNotebook = findOpenNotebook(uri)
    let localUri: string | undefined =
      uri.startsWith('local://') || uri.startsWith('fs://') ? uri : undefined
    let remoteUri: string | undefined = driveUri ?? undefined
    let title = openNotebook?.getName() ?? ''

    if (localStore && uri.startsWith('local://')) {
      const metadata = await localStore.getMetadata(uri)
      if (metadata) {
        title = metadata.name || title
        localUri = metadata.uri
        remoteUri = metadata.remoteUri?.trim() || remoteUri
      }
    } else if (driveUri) {
      const record = await findLocalRecordForRemote(driveUri)
      if (record) {
        title = record.name || title
        localUri = record.id
        remoteUri = driveUri
      } else if (appState.driveNotebookStore) {
        try {
          const metadata =
            await appState.driveNotebookStore.getMetadata(driveUri)
          title = metadata?.name || title
        } catch {
          // Metadata lookup may require auth; the reference is still useful.
        }
      }
    }

    const shareTarget = getNotebookShareTarget(localUri ?? uri, remoteUri)
    const resolvedTitle =
      title || deriveTitleFromUri(remoteUri ?? localUri ?? uri)
    return {
      input,
      uri,
      localUri,
      remoteUri,
      googleDriveUrl:
        remoteUri && isDriveItemUri(remoteUri) ? remoteUri : undefined,
      shareTarget,
      shareUrl: buildNotebookShareUrl(shareTarget),
      markdownLink: buildNotebookMarkdownLink(resolvedTitle, shareTarget),
      title: resolvedTitle,
      name: resolvedTitle,
      source:
        remoteUri && isDriveItemUri(remoteUri)
          ? 'drive'
          : localUri?.startsWith('fs://')
            ? 'fs'
            : localUri?.startsWith('local://')
              ? 'local'
              : 'unknown',
    }
  }

  const showNotebookReference = async (reference?: unknown) => {
    const info = await resolveNotebookReference(reference)
    if (info.localUri?.startsWith('local://file/')) {
      await openNotebookForRuntime(info.localUri)
      return {
        ...info,
        opened: info.localUri,
      }
    }
    if (info.remoteUri && isDriveItemUri(info.remoteUri)) {
      await driveLinkCoordinator.enqueue(info.remoteUri, 'manual')
      return {
        ...info,
        opened: info.remoteUri,
        status: 'queued_drive_link_coordination',
      }
    }
    throw new Error(
      `Unable to show notebook reference ${info.uri}. Expected a local file URI or Drive file URL.`
    )
  }

  const notebooksHelpers = {
    ...notebooksApi,
    help: async (topic?: string) => {
      if (topic === 'createLocal') {
        return 'notebooks.createLocal(name, options?: { folderUri?: string }): Promise<NotebookDocument>. Creates a new local notebook, opens it in the UI, and returns the notebook document.'
      }
      if (topic === 'appendCell') {
        return 'notebooks.appendCell({ target?, at?, kind, languageId?, value?, metadata?, execute?, reason? }): Promise<{ handle, cell }>. Inserts a cell into the current or targeted notebook. kind must be "code" or "markup".'
      }
      if (topic === 'resolve') {
        return 'notebooks.resolve(reference?): Promise<NotebookReferenceInfo>. Accepts a local URI, Drive URL, Runme share URL, Markdown link, or notebook target and returns title, localUri, remoteUri, shareUrl, and markdownLink.'
      }
      if (topic === 'show') {
        return 'notebooks.show(reference?): Promise<NotebookReferenceInfo & { opened | status }>. Opens local notebook references directly and queues Drive references through shared-link coordination.'
      }
      if (topic === 'shareUrl') {
        return 'notebooks.shareUrl(reference?): Promise<string>. Returns the Runme share URL for a local, Drive, share, or Markdown notebook reference.'
      }
      if (topic === 'markdownLink' || topic === 'link') {
        return 'notebooks.markdownLink(reference?): Promise<string>. Returns [title](shareUrl) Markdown for a local, Drive, share, or Markdown notebook reference.'
      }
      const base = await notebooksApi.help(topic as any)
      if (topic) {
        return base
      }
      return [
        base,
        '- notebooks.createLocal(name, options?)',
        '- notebooks.appendCell({ target?, at?, kind, languageId?, value?, metadata?, execute?, reason? })',
        '- notebooks.resolve(reference?)',
        '- notebooks.show(reference?)',
        '- notebooks.shareUrl(reference?)',
        '- notebooks.markdownLink(reference?)',
      ].join('\n')
    },
    createLocal: async (
      name: string,
      options?: {
        folderUri?: string
      }
    ) => {
      const uri = await createLocalNotebookAndOpen(name, options?.folderUri)
      return notebooksApi.get({ uri })
    },
    appendCell: async (args: {
      target?: { uri: string } | { handle: { uri: string; revision: string } }
      at?: { index: number } | { beforeRefId: string } | { afterRefId: string }
      kind?: 'code' | 'markup'
      languageId?: string
      value?: string
      metadata?: Record<string, string>
      execute?: boolean
      reason?: string
    }) => {
      if (args?.kind !== 'code' && args?.kind !== 'markup') {
        throw new Error(
          'Usage: notebooks.appendCell({ kind: "code" | "markup", target?, at?, languageId?, value?, metadata?, execute?, reason? })'
        )
      }
      return await appendNotebookCell({
        target: args?.target,
        at: args?.at,
        execute: args?.execute,
        reason: args?.reason,
        cell: {
          kind: args.kind,
          languageId:
            args.languageId ??
            (args.kind === 'markup' ? 'markdown' : 'javascript'),
          value: args?.value ?? '',
          metadata: args?.metadata ?? {},
        },
      })
    },
    resolve: resolveNotebookReference,
    show: showNotebookReference,
    shareUrl: async (reference?: unknown) => {
      const info = await resolveNotebookReference(reference)
      return info.shareUrl
    },
    markdownLink: async (reference?: unknown) => {
      const info = await resolveNotebookReference(reference)
      return info.markdownLink
    },
    link: async (reference?: unknown) => {
      const info = await resolveNotebookReference(reference)
      return info.markdownLink
    },
  }

  const googleClientRuntimeApi = {
    get: () => googleClientManager.getOAuthClient(),
    getOAuthClient: () => googleClientManager.getOAuthClient(),
    setOAuthClient: (config: {
      clientId?: string
      clientSecret?: string
      authFlow?: 'implicit' | 'pkce' | 'service_account'
      authUxMode?: 'popup' | 'redirect' | 'new_tab'
      serviceAccount?: {
        clientEmail: string
        privateKey: string
        privateKeyId?: string
        tokenUri?: string
        subject?: string
        scopes?: string[]
      }
    }) => googleClientManager.setOAuthClient(config),
    setClientId: (clientId: string) =>
      googleClientManager.setOAuthClient({ clientId }),
    setClientSecret: (clientSecret: string) =>
      googleClientManager.setClientSecret(clientSecret),
    setAuthFlow: (authFlow: 'implicit' | 'pkce' | 'service_account') =>
      googleClientManager.setAuthFlow(authFlow),
    setAuthUxMode: (authUxMode: 'popup' | 'redirect' | 'new_tab') =>
      googleClientManager.setAuthUxMode(authUxMode),
    setFromJson: (raw: string) =>
      googleClientManager.setOAuthClientFromJson(raw),
    setOAuthClientFromJson: (raw: string) =>
      googleClientManager.setOAuthClientFromJson(raw),
    setServiceAccountFromFile: async () => {
      const selection = await pickJsonFromLocalFilesystem()
      if (!selection) {
        const message = 'Google service account credential selection cancelled.'
        emitLine(sendOutput, message)
        return null
      }
      const config = googleClientManager.setOAuthClientFromJson(selection.text)
      if (config.authFlow !== 'service_account') {
        throw new Error(
          `Selected JSON file (${selection.name}) did not contain Google service account credentials.`
        )
      }
      await ensureAccessToken?.({ interactive: false })
      const message = `Loaded Google Drive service account credentials from ${selection.name}.`
      emitLine(sendOutput, message)
      return config
    },
    setServiceAccountFromFilePath: async (keyPath: string) => {
      const selection = await readServiceAccountJsonFromLocalPath(keyPath)
      const config = googleClientManager.setOAuthClientFromJson(selection.text)
      if (config.authFlow !== 'service_account') {
        throw new Error(
          `Selected JSON file (${selection.name}) did not contain Google service account credentials.`
        )
      }
      await ensureAccessToken?.({ interactive: false })
      const message = `Loaded Google Drive service account credentials from ${keyPath}.`
      emitLine(sendOutput, message)
      return config
    },
    getDrivePickerConfig: () => googleClientManager.getDrivePickerConfig(),
    setDrivePickerConfig: (
      config: Partial<
        ReturnType<typeof googleClientManager.getDrivePickerConfig>
      >
    ) => googleClientManager.setDrivePickerConfig(config),
    help: () => {
      const message = [
        'googleClientManager.get()                         - Show Google Drive auth config',
        'googleClientManager.setClientId(clientId)         - Set Google OAuth client ID',
        'googleClientManager.setClientSecret(secret)       - Set Google OAuth client secret',
        'googleClientManager.setAuthFlow(flow)             - Set implicit, pkce, or service_account',
        'googleClientManager.setAuthUxMode(mode)           - Set popup, redirect, or new_tab',
        'googleClientManager.setFromJson(jsonText)         - Load OAuth or service account JSON text',
        'await googleClientManager.setServiceAccountFromFile() - Pick a local service account JSON key file',
        'await googleClientManager.setServiceAccountFromFilePath(path) - Load a service account JSON key path from the dev server',
      ].join('\n')
      emitLine(sendOutput, message)
      return message
    },
  }

  return {
    runme: runmeApi,
    notebooks: notebooksHelpers,
    documents: documentsHelpers,
    notebookDiff: notebookDiffApi,
    codex: codexApi,
    opfs: {
      exists: (path: string) => {
        if (!opfsApi) {
          throw new Error('opfs API is not available in this runtime.')
        }
        return opfsApi.exists(path)
      },
      readText: (path: string) => {
        if (!opfsApi) {
          throw new Error('opfs API is not available in this runtime.')
        }
        return opfsApi.readText(path)
      },
      writeText: (path: string, text: string) => {
        if (!opfsApi) {
          throw new Error('opfs API is not available in this runtime.')
        }
        return opfsApi.writeText(path, text)
      },
      readBytes: (path: string) => {
        if (!opfsApi) {
          throw new Error('opfs API is not available in this runtime.')
        }
        return opfsApi.readBytes(path)
      },
      writeBytes: (path: string, bytes: Uint8Array) => {
        if (!opfsApi) {
          throw new Error('opfs API is not available in this runtime.')
        }
        return opfsApi.writeBytes(path, bytes)
      },
      list: (path: string) => {
        if (!opfsApi) {
          throw new Error('opfs API is not available in this runtime.')
        }
        return opfsApi.list(path)
      },
      mkdir: (path: string, options?: { recursive?: boolean }) => {
        if (!opfsApi) {
          throw new Error('opfs API is not available in this runtime.')
        }
        return opfsApi.mkdir(path, options)
      },
      stat: (path: string) => {
        if (!opfsApi) {
          throw new Error('opfs API is not available in this runtime.')
        }
        return opfsApi.stat(path)
      },
      remove: (path: string, options?: { recursive?: boolean }) => {
        if (!opfsApi) {
          throw new Error('opfs API is not available in this runtime.')
        }
        return opfsApi.remove(path, options)
      },
      help: () => {
        return [
          'opfs.exists(path)                - Return true if the path exists',
          'opfs.readText(path)              - Read a UTF-8 text file',
          'opfs.writeText(path, text)       - Write a UTF-8 text file',
          'opfs.readBytes(path)             - Read a file as Uint8Array',
          'opfs.writeBytes(path, bytes)     - Write a Uint8Array file',
          'opfs.list(path)                  - List directory entries',
          'opfs.mkdir(path, { recursive? }) - Create a directory',
          'opfs.stat(path)                  - Return file or directory metadata',
          'opfs.remove(path, { recursive? }) - Remove a file or directory',
          'opfs.help()                      - Show this help',
        ].join('\n')
      },
    },
    net: {
      get: (
        url: string,
        options?: {
          headers?: Record<string, string>
          responseType?: 'text' | 'bytes' | 'json'
        }
      ) => {
        if (!networkApi) {
          throw new Error('net API is not available in this runtime.')
        }
        return networkApi.get(url, options)
      },
      help: () => {
        return [
          'net.get(url, { headers?, responseType? }) - Perform an HTTP GET request',
          "  responseType: 'text' | 'bytes' | 'json' (default: 'text')",
          'net.help()                                - Show this help',
        ].join('\n')
      },
    },
    runmeRunners: {
      get: () => {
        const mgr = getRunnersManager()
        const runners = mgr.list()
        if (runners.length === 0) {
          return 'No runners configured.'
        }
        return runners
          .map((runner) => {
            const isDefault = runner.name === mgr.getDefaultRunnerName()
            const endpoint =
              typeof runner.endpoint === 'string' &&
              runner.endpoint.trim() !== ''
                ? runner.endpoint
                : '<endpoint not set>'
            return `${runner.name}: ${endpoint}${isDefault ? ' (default)' : ''}`
          })
          .join('\n')
      },
      update: (name: string, endpoint: string) => {
        const mgr = getRunnersManager()
        const updated = mgr.update(name, endpoint)
        if (runnerSync?.onUpdated) {
          runnerSync.onUpdated(updated)
        } else {
          appState.syncRunnerUpdate(updated)
        }
        return `Runner ${name} set to ${endpoint}`
      },
      delete: (name: string) => {
        const mgr = getRunnersManager()
        mgr.delete(name)
        if (runnerSync?.onDeleted) {
          runnerSync.onDeleted(name)
        } else {
          appState.syncRunnerDelete(name)
        }
        return `Runner ${name} deleted`
      },
      getDefault: () => {
        const mgr = getRunnersManager()
        const defaultName = mgr.getDefaultRunnerName()
        if (!defaultName) {
          return 'No default runner set.'
        }
        const runner = mgr.get(defaultName)
        const endpoint =
          runner && typeof runner.endpoint === 'string'
            ? runner.endpoint
            : '<endpoint not set>'
        return `Default runner: ${defaultName} (${endpoint})`
      },
      setDefault: (name: string) => {
        const mgr = getRunnersManager()
        const runner = mgr.get(name)
        if (!runner) {
          return `Runner ${name} not found`
        }
        mgr.setDefault(name)
        if (runnerSync?.onDefaultSet) {
          runnerSync.onDefaultSet(name)
        } else {
          appState.syncRunnerDefault(name)
        }
        return `Default runner set to ${name}`
      },
      help: () => {
        return [
          'runmeRunners.get()                                - List configured runners',
          'runmeRunners.update(name, endpoint)               - Create or update a runner endpoint',
          'runmeRunners.ensure(name, endpoint, { setDefault?: boolean }) - Update a runner and optionally set it as default',
          'runmeRunners.delete(name)                         - Delete a runner',
          'runmeRunners.getDefault()                         - Show the default runner',
          'runmeRunners.setDefault(name)                     - Set the default runner',
          'runmeRunners.help()                               - Show this help',
        ].join('\n')
      },
      ensure: (
        name: string,
        endpoint: string,
        options?: {
          setDefault?: boolean
        }
      ) => {
        const trimmedName = name?.trim()
        const trimmedEndpoint = endpoint?.trim()
        if (!trimmedName || !trimmedEndpoint) {
          return 'Usage: runmeRunners.ensure(name, endpoint, { setDefault?: boolean })'
        }
        const updatedMessage = [
          `Runner ${trimmedName} set to ${trimmedEndpoint}`,
        ]
        const mgr = getRunnersManager()
        const updated = mgr.update(trimmedName, trimmedEndpoint)
        if (runnerSync?.onUpdated) {
          runnerSync.onUpdated(updated)
        } else {
          appState.syncRunnerUpdate(updated)
        }
        if (options?.setDefault) {
          mgr.setDefault(trimmedName)
          if (runnerSync?.onDefaultSet) {
            runnerSync.onDefaultSet(trimmedName)
          } else {
            appState.syncRunnerDefault(trimmedName)
          }
          updatedMessage.push(`Default runner set to ${trimmedName}`)
        }
        return updatedMessage.join('\n')
      },
    },
    jupyter: {
      servers: {
        get: async (runnerName: string) => {
          if (!runnerName?.trim()) {
            throw new Error('Usage: jupyter.servers.get(runnerName)')
          }
          try {
            const servers = await jupyterManager.listServers(runnerName)
            const message =
              servers.length === 0
                ? 'No Jupyter servers configured.'
                : JSON.stringify(servers, null, 2)
            emitLine(sendOutput, message)
            return servers
          } catch (error) {
            const message = `Failed to list Jupyter servers: ${String(error)}`
            emitLine(sendOutput, message)
            throw error
          }
        },
      },
      kernels: {
        start: async (
          runnerName: string,
          serverName: string,
          options?: { kernelSpec?: string; name?: string; path?: string }
        ) => {
          if (!runnerName?.trim() || !serverName?.trim()) {
            throw new Error(
              'Usage: jupyter.kernels.start(runnerName, serverName, options?)'
            )
          }
          try {
            const kernel = await jupyterManager.startKernel(
              runnerName,
              serverName,
              options
            )
            const message = `Started kernel ${kernel.id} on ${runnerName}/${serverName} (${kernel.name})`
            emitLine(sendOutput, message)
            emitLine(sendOutput, JSON.stringify(kernel, null, 2))
            return kernel
          } catch (error) {
            const message = `Failed to start Jupyter kernel: ${String(error)}`
            emitLine(sendOutput, message)
            throw error
          }
        },
        get: async (runnerName: string, serverName: string) => {
          if (!runnerName?.trim() || !serverName?.trim()) {
            throw new Error(
              'Usage: jupyter.kernels.get(runnerName, serverName)'
            )
          }
          try {
            const kernels = await jupyterManager.listKernels(
              runnerName,
              serverName
            )
            const message =
              kernels.length === 0
                ? `No kernels running on ${runnerName}/${serverName}.`
                : JSON.stringify(kernels, null, 2)
            emitLine(sendOutput, message)
            return kernels
          } catch (error) {
            const message = `Failed to list Jupyter kernels: ${String(error)}`
            emitLine(sendOutput, message)
            throw error
          }
        },
        stop: async (
          runnerName: string,
          serverName: string,
          kernelNameOrId: string
        ) => {
          if (
            !runnerName?.trim() ||
            !serverName?.trim() ||
            !kernelNameOrId?.trim()
          ) {
            throw new Error(
              'Usage: jupyter.kernels.stop(runnerName, serverName, kernelNameOrId)'
            )
          }
          try {
            await jupyterManager.stopKernel(
              runnerName,
              serverName,
              kernelNameOrId
            )
            const message = `Stopped kernel ${kernelNameOrId} on ${runnerName}/${serverName}`
            emitLine(sendOutput, message)
            return message
          } catch (error) {
            const message = `Failed to stop Jupyter kernel: ${String(error)}`
            emitLine(sendOutput, message)
            throw error
          }
        },
      },
    },
    agent: {
      get: () => {
        const snapshot = agentEndpointManager.getSnapshot()
        const current = snapshot.endpoint?.trim() || '<not set>'
        const defaultEndpoint = snapshot.defaultEndpoint?.trim() || '<not set>'
        const message = `Agent endpoint: ${current}\nDefault agent endpoint: ${defaultEndpoint}`
        emitLine(sendOutput, message)
        return message
      },
      update: (endpoint: string) => {
        const trimmed = endpoint?.trim()
        if (!trimmed) {
          const message = 'Usage: agent.update(endpoint)'
          emitLine(sendOutput, message)
          return message
        }
        agentEndpointManager.set(trimmed)
        aisreClientManager.setDefault({ baseUrl: trimmed })
        const message = `Agent endpoint set to ${trimmed}`
        emitLine(sendOutput, message)
        return message
      },
      setDefault: () => {
        const defaultEndpoint = agentEndpointManager.reset()
        if (!defaultEndpoint) {
          const message = 'Default agent endpoint is not configured.'
          emitLine(sendOutput, message)
          return message
        }
        aisreClientManager.setDefault({ baseUrl: defaultEndpoint })
        const message = `Agent endpoint reset to default (${defaultEndpoint})`
        emitLine(sendOutput, message)
        return message
      },
      help: () => {
        const message = [
          'agent.get()                 - Show current and default agent endpoint',
          'agent.update(endpoint)      - Set the active agent endpoint',
          'agent.setDefault()          - Reset agent endpoint to app default',
          'agent.help()                - Show this help',
        ].join('\n')
        emitLine(sendOutput, message)
        return message
      },
    },
    googleClientManager: googleClientRuntimeApi,
    oidc: {
      get: () => oidcConfigManager.getConfig(),
      getRedirectURI: () => oidcConfigManager.getRedirectURI(),
      getScope: () => oidcConfigManager.getScope(),
      set: (config: Partial<OidcConfig>) => oidcConfigManager.setConfig(config),
      setClientId: (clientId: string) =>
        oidcConfigManager.setClientId(clientId),
      setClientSecret: (clientSecret: string) =>
        oidcConfigManager.setClientSecret(clientSecret),
      setDiscoveryURL: (discoveryUrl: string) =>
        oidcConfigManager.setDiscoveryURL(discoveryUrl),
      setClientToDrive: () => oidcConfigManager.setClientToDrive(),
      setScope: (scope: string) => oidcConfigManager.setScope(scope),
      setGoogleDefaults: () => oidcConfigManager.setGoogleDefaults(),
      getStatus: async () => {
        const authData = await getAuthData()
        if (!authData) {
          emitLine(sendOutput, 'Is Authenticated: No')
          return { isAuthenticated: false }
        }
        let decodedAccessToken: unknown = null
        let decodedIdToken: unknown = null
        try {
          decodedAccessToken = jwtDecode(authData.accessToken)
        } catch (error) {
          emitLine(
            sendOutput,
            `Failed to decode access token: ${String(error)}`
          )
        }
        try {
          if (authData.idToken) {
            decodedIdToken = jwtDecode(authData.idToken)
          }
        } catch (error) {
          emitLine(sendOutput, `Failed to decode ID token: ${String(error)}`)
        }
        const status = {
          isAuthenticated: true,
          isExpired: authData.isExpired(),
          rawAuthData: authData,
          decodedAccessToken,
          decodedIdToken,
          tokenType: authData.tokenType,
          scope: authData.scope,
        }
        emitLine(sendOutput, 'Is Authenticated: Yes')
        emitLine(sendOutput, `Is Expired: ${status.isExpired ? 'Yes' : 'No'}`)
        emitLine(sendOutput, JSON.stringify(status, null, 2))
        return status
      },
    },
    credentials: {
      google: googleClientRuntimeApi,
      oidc: oidcConfigManager,
      openai: {
        get: () => responsesDirect.getSnapshot(),
        setAuthMethod: (authMethod: string) => {
          return responsesDirect.setAuthMethod(authMethod)
        },
        setOpenAIOrganization: (openaiOrganization: string) => {
          return responsesDirect.setOpenAIOrganization(openaiOrganization)
        },
        setOpenAIProject: (openaiProject: string) => {
          return responsesDirect.setOpenAIProject(openaiProject)
        },
        setVectorStores: (vectorStores: string[] | string) => {
          return responsesDirect.setVectorStores(
            parseVectorStores(vectorStores)
          )
        },
        setAPIKey: (apiKey: string) => {
          return responsesDirect.setAPIKey(apiKey)
        },
        clearAPIKey: () => {
          return responsesDirect.clearAPIKey()
        },
      },
    },
    app: {
      getSessionId: () => getClaimedSessionId(),
      getSessionID: () => getClaimedSessionId(),
      getDefaultConfigUrl: () => getDefaultAppConfigUrl(),
      isLocalConfigPreferredOnLoad: () => isLocalConfigPreferredOnLoad(),
      setLocalConfigPreferredOnLoad: (preferLocal: boolean) => {
        const applied = setLocalConfigPreferredOnLoad(Boolean(preferLocal))
        const message = `App config load precedence set to ${applied ? 'local storage' : 'app-config'}`
        emitLine(sendOutput, message)
        return applied
      },
      disableConfigOverridesOnLoad: () => {
        const applied = disableAppConfigOverridesOnLoad()
        emitLine(sendOutput, 'App config overrides on load disabled.')
        return applied
      },
      enableConfigOverridesOnLoad: () => {
        const applied = enableAppConfigOverridesOnLoad()
        emitLine(sendOutput, 'App config overrides on load enabled.')
        return applied
      },
      openNotebook: async (uri: string) => {
        if (!uri?.trim()) {
          throw new Error('Usage: app.openNotebook(localUri)')
        }
        await openNotebookForRuntime(uri)
        emitLine(sendOutput, `Opened notebook ${uri}`)
        return uri
      },
      startGoogleDriveOAuth: startGoogleDriveOAuthForRuntime,
      setConfig: async (url?: string) => {
        emitLine(sendOutput, 'Fetching app config...')
        try {
          const applied = await setAppConfig(url)
          if (applied.warnings.length > 0) {
            applied.warnings.forEach((warning) => {
              emitLine(sendOutput, `Warning: ${warning}`)
            })
          }
          emitLine(sendOutput, 'App config applied.')
          return applied
        } catch (error) {
          const message = `Failed to apply app config: ${String(error)}`
          emitLine(sendOutput, message)
          throw error
        }
      },
      setConfigFromYaml: async (yamlText: string, source?: string) => {
        emitLine(sendOutput, 'Applying app config YAML...')
        try {
          const applied = setAppConfigFromYaml(yamlText, source)
          if (applied.warnings.length > 0) {
            applied.warnings.forEach((warning) => {
              emitLine(sendOutput, `Warning: ${warning}`)
            })
          }
          emitLine(sendOutput, 'App config applied.')
          return applied
        } catch (error) {
          const message = `Failed to apply app config YAML: ${String(error)}`
          emitLine(sendOutput, message)
          throw error
        }
      },
      harness: {
        get: () => {
          const harnesses = harnessManager.list()
          if (harnesses.length === 0) {
            const message = 'No harnesses configured.'
            emitLine(sendOutput, message)
            return message
          }
          const message = harnesses
            .map((harness) =>
              formatHarness(harness, { includeDefaultMarker: true })
            )
            .join('\n')
          emitLine(sendOutput, message)
          return message
        },
        update: (name: string, baseUrl: string, adapter: string) => {
          const normalized = normalizeHarnessAdapter(adapter)
          const updated = harnessManager.update(
            name,
            baseUrl,
            normalized.adapter
          )
          harnessRuntimeManager.reconcile(updated)
          const message = normalized.warning
            ? `Harness ${updated.name} set to ${updated.baseUrl} (${updated.adapter})\nWarning: ${normalized.warning}`
            : `Harness ${updated.name} set to ${updated.baseUrl} (${updated.adapter})`
          emitLine(sendOutput, message)
          return message
        },
        delete: (name: string) => {
          harnessManager.delete(name)
          harnessRuntimeManager.remove(name)
          const message = `Harness ${name} deleted`
          emitLine(sendOutput, message)
          return message
        },
        getDefault: () => {
          const message = formatDefaultHarness(harnessManager.getDefault())
          emitLine(sendOutput, message)
          return message
        },
        setDefault: (name: string) => {
          harnessManager.setDefault(name)
          const message = `Default harness set to ${name}`
          emitLine(sendOutput, message)
          return message
        },
        getActiveChatkitUrl: () => {
          const active = harnessManager.getDefault()
          const chatkitUrl = harnessManager.resolveChatkitUrl(active)
          const message = `Active ChatKit URL: ${chatkitUrl} (${active.name}, ${active.adapter})`
          emitLine(sendOutput, message)
          return message
        },
      },
      codex: codexApi,
      responsesDirect: {
        get: () => responsesDirect.getSnapshot(),
        setAuthMethod: (authMethod: string) => {
          return responsesDirect.setAuthMethod(authMethod)
        },
        setOpenAIOrganization: (openaiOrganization: string) => {
          return responsesDirect.setOpenAIOrganization(openaiOrganization)
        },
        setOpenAIProject: (openaiProject: string) => {
          return responsesDirect.setOpenAIProject(openaiProject)
        },
        setVectorStores: (vectorStores: string[] | string) => {
          return responsesDirect.setVectorStores(
            parseVectorStores(vectorStores)
          )
        },
        setAPIKey: (apiKey: string) => {
          return responsesDirect.setAPIKey(apiKey)
        },
        clearAPIKey: () => {
          return responsesDirect.clearAPIKey()
        },
      },
    },
    help: () => {
      const message = [
        'Available namespaces:',
        '  runme           - Notebook helpers (run all, clear outputs)',
        '  notebooks       - Notebook document API plus create/append helpers',
        '  documents       - Raw URI-based document content get/update helpers',
        '  notebookDiff    - Compare revisions and resolve notebook sync conflicts',
        '  opfs            - Origin-private browser file storage helpers',
        '  net             - Browser network helpers',
        '  codex           - Codex project and turn-journal helpers',
        '  explorer        - Manage workspace folders and notebooks',
        '  runmeRunners    - Configure runner endpoints',
        '  jupyter         - Manage Jupyter servers and kernels',
        '  agent           - Configure assistant/API agent endpoint',
        '  files           - Import local files and access their bytes',
        '  drive           - List/create/copy/update Google Drive notebook files',
        '  oidc            - OIDC/OAuth configuration and auth status',
        '  googleClientManager - Google OAuth client settings',
        '  app             - App-level configuration helpers',
        '  credentials     - Shorthand for google/oidc/openai credential managers',
        '',
        'High-value commands:',
        '  await app.getSessionId()',
        '  await app.getSessionID()',
        '  await notebooks.createLocal("hello")',
        '  const doc = await documents.get("local://file/...")',
        '  await notebooks.appendCell({ kind: "code", value: "print(1)", languageId: "python" })',
        '  const diff = await notebookDiff.diffDriveRevision({ revisionId })',
        '  await drive.authorize()',
        '  runmeRunners.ensure("openai-local", "ws://localhost:9988/ws", { setDefault: true })',
        '',
        'Type <namespace>.help() for detailed commands, e.g. explorer.help()',
      ].join('\n')
      emitLine(sendOutput, message)
      return message
    },
    explorer: {
      addFolder: (path?: string) => {
        if (path) {
          return 'explorer.addFolder() does not accept a path when using the File System Access API.'
        }
        return openWorkspaceAndAdd()
      },
      mountDrive: (driveUrl: string) => {
        if (!driveUrl) {
          return 'Usage: explorer.mountDrive(driveUrl)'
        }
        addWorkspaceItem(driveUrl)
        return `Mounted Drive link: ${driveUrl}`
      },
      openPicker: () => openWorkspaceAndAdd(),
      importMarkdown: () => {
        void importMarkdownAndOpen()
        return 'Opening markdown file picker...'
      },
      removeFolder: (uri: string) => {
        if (!uri) {
          return 'Usage: explorer.removeFolder(uri)'
        }
        removeWorkspaceItem(uri)
        return `Removed: ${uri}`
      },
      listFolders: () => {
        const items = getWorkspaceItems()
        if (items.length === 0) {
          return 'No folders in workspace.'
        }
        return items.join('\n')
      },
      help: () => {
        return [
          'explorer.addFolder()           - Open the folder picker and mount a local folder',
          'explorer.mountDrive(driveUrl)   - Mount a Google Drive link',
          'explorer.openPicker()           - Alias for explorer.addFolder()',
          'explorer.importMarkdown()       - Import a local Markdown file as a notebook',
          'explorer.removeFolder(uri)      - Remove a folder from workspace',
          'explorer.listFolders()          - List all workspace folders',
          'explorer.help()                 - Show this help',
        ].join('\n')
      },
    },
    files: {
      pickMarkdown: async () => {
        const picked = await pickMarkdownSource()
        if (!picked) {
          emitLine(sendOutput, 'Markdown pick cancelled.')
          return null
        }
        emitLine(sendOutput, `Picked ${picked.name} -> ${picked.sourceUri}`)
        return picked
      },
      importMarkdown: async (sourceUri: string, targetFolderUri?: string) => {
        if (!sourceUri) {
          throw new Error(
            'Usage: files.importMarkdown(sourceUri, targetFolderUri?)'
          )
        }
        const selection = getPickedMarkdownSelection(sourceUri)
        const store = resolveStore()
        if (!store) {
          throw new Error('Notebook store is not initialized yet.')
        }
        const notebook = await deserializeMarkdownToNotebook(selection)
        const fileName = toImportedNotebookName(selection.name)
        const parentUri = targetFolderUri || LOCAL_FOLDER_URI
        const created = await store.create(parentUri, fileName)
        await store.save(created.uri, notebook)
        if (!getWorkspaceItems().includes(parentUri)) {
          addWorkspaceItem(parentUri)
        }
        if (!getWorkspaceItems().includes(LOCAL_FOLDER_URI)) {
          addWorkspaceItem(LOCAL_FOLDER_URI)
        }
        registerImportedMarkdownForUri(created.uri, selection)
        emitLine(sendOutput, `Imported ${selection.name} -> ${created.uri}`)
        return {
          localUri: created.uri,
          sourceUri,
          name: selection.name,
          notebookName: fileName,
          size: selection.bytes.byteLength,
        }
      },
      getBytes: (localUri: string) => {
        if (!localUri) {
          throw new Error('Usage: files.getBytes(localUri)')
        }
        return getImportedFileBytes(localUri)
      },
      getName: (localUri: string) => {
        if (!localUri) {
          throw new Error('Usage: files.getName(localUri)')
        }
        return getImportedFileName(localUri)
      },
      help: () => {
        return [
          'files.pickMarkdown()           - Open local picker and return sourceUri',
          'files.importMarkdown(sourceUri, targetFolderUri?) - Import picked markdown into local notebooks',
          'files.getBytes(localUri)       - Return imported Markdown Uint8Array bytes for a local notebook URI',
          'files.getName(localUri)        - Return original filename for imported file URI',
          'files.help()                   - Show this help',
        ].join('\n')
      },
    },
    drive: {
      authorize: startGoogleDriveOAuthForRuntime,
      refreshAuth: startGoogleDriveOAuthForRuntime,
      list: async (folder: string) => {
        const items = await listDriveFolderItems(folder)
        emitLine(sendOutput, `Listed ${items.length} Drive item(s)`)
        return items
      },
      create: async (folder: string, name: string) => {
        const id = await createDriveFile(folder, name)
        emitLine(sendOutput, `Created Drive file ${id}`)
        return id
      },
      update: async (idOrUri: string, bytes: Uint8Array) => {
        const id = await updateDriveFileBytes(idOrUri, bytes)
        emitLine(sendOutput, `Updated Drive file ${id}`)
        return id
      },
      trash: async (idOrUri: string) => {
        const item = await moveDriveFileToTrash(idOrUri)
        emitLine(sendOutput, `Moved Drive file to trash: ${item.name}`)
        return item
      },
      moveToTrash: async (idOrUri: string) => {
        const item = await moveDriveFileToTrash(idOrUri)
        emitLine(sendOutput, `Moved Drive file to trash: ${item.name}`)
        return item
      },
      saveAsCurrentNotebook: async (folder: string, name: string) => {
        if (!folder?.trim() || !name?.trim()) {
          throw new Error(
            'Usage: drive.saveAsCurrentNotebook(folderIdOrUri, fileName)'
          )
        }
        const notebook = runme.getCurrentNotebook()
        if (!notebook) {
          throw new Error('No active notebook handle available.')
        }
        const result = await saveNotebookAsDriveCopy(
          notebook.getNotebook(),
          folder,
          name
        )
        emitLine(
          sendOutput,
          `Saved notebook as ${result.fileName} (${result.fileId}) and switched to ${result.localUri}`
        )
        return result
      },
      copyNotebook: async (
        sourceIdOrUri: string,
        targetFolder: string,
        targetName?: string
      ) => {
        const result = await copyDriveNotebookFile(
          sourceIdOrUri,
          targetFolder,
          targetName
        )
        emitLine(
          sendOutput,
          `Copied notebook ${result.sourceUri} -> ${result.targetUri}`
        )
        return result
      },
      listPendingSync: async () => {
        const localStore = resolveLocalMirrorStore()
        const pending = await localStore.listDriveBackedFilesNeedingSync()
        if (pending.length === 0) {
          emitLine(sendOutput, 'No Drive-backed notebooks pending sync.')
          return pending
        }
        emitLine(
          sendOutput,
          `Drive-backed notebooks pending sync (${pending.length}):`
        )
        pending.forEach((uri) => emitLine(sendOutput, `- ${uri}`))
        return pending
      },
      requeuePendingSync: async () => {
        const localStore = resolveLocalMirrorStore()
        const enqueued = await localStore.enqueueDriveBackedFilesNeedingSync()
        if (enqueued.length === 0) {
          emitLine(sendOutput, 'No Drive-backed notebooks required requeue.')
          return enqueued
        }
        emitLine(
          sendOutput,
          `Requeued Drive-backed notebooks for sync (${enqueued.length}):`
        )
        enqueued.forEach((uri) => emitLine(sendOutput, `- ${uri}`))
        return enqueued
      },
      help: () => {
        return [
          'drive.list(folder)            - List Drive items in a folder',
          'drive.authorize(options?)      - Start a fresh Google Drive OAuth flow; options: { mode?, prompt? }',
          'drive.refreshAuth(options?)    - Alias for drive.authorize(options?)',
          'drive.create(folder, name)     - Create a Drive file in folder; returns file id',
          'drive.update(id, bytes)        - Write UTF-8 bytes to a Drive file id/URI',
          'drive.trash(idOrUri)           - Move a Drive file to Google Drive trash',
          'drive.moveToTrash(idOrUri)     - Alias for drive.trash(idOrUri)',
          'drive.saveAsCurrentNotebook(folder, fileName) - Save current notebook to Drive and switch current doc',
          'drive.copyNotebook(source, targetFolder, fileName?) - Copy a notebook file to another Drive folder',
          'drive.listPendingSync()        - List Drive-backed local notebooks that currently need sync',
          'drive.requeuePendingSync()     - Requeue all Drive-backed local notebooks that need sync',
          'drive.help()                   - Show this help',
        ].join('\n')
      },
    },
  }
}
