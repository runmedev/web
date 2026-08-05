import { getBrowserAdapter } from '../../browserAdapter.client'
import { getAuthData } from '../../token'
import { appLogger } from '../logging/runtime'
import { DEFAULT_RUNNER_PLACEHOLDER, getRunnersManager } from './runnersManager'

const KERNEL_ALIASES_STORAGE_KEY = 'runme/jupyterKernelAliases'

export type JupyterKernelModel = {
  id: string
  name: string
  last_activity?: string
  execution_state?: string
  connections?: number
}

export type JupyterKernelStartOptions = {
  kernelSpec?: string
  name?: string
}

export type JupyterKernelOption = {
  key: string
  label: string
  runnerName: string
  kernelId: string
  kernelName: string
}

type KernelCacheEntry = {
  model: JupyterKernelModel
  label: string
}

function normalizeKernelName(value: string): string {
  return value.trim().toLowerCase()
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value)
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function runnerEndpointToHttpBase(runnerEndpoint: string): string {
  const parsed = new URL(runnerEndpoint)
  if (parsed.protocol === 'ws:') {
    parsed.protocol = 'http:'
  } else if (parsed.protocol === 'wss:') {
    parsed.protocol = 'https:'
  }
  parsed.pathname = ''
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString().replace(/\/$/, '')
}

export function buildJupyterChannelsWebSocketURL(args: {
  runnerEndpoint: string
  kernelId: string
  authorization?: string
}): string {
  const parsed = new URL(args.runnerEndpoint)
  if (parsed.protocol === 'http:') {
    parsed.protocol = 'ws:'
  } else if (parsed.protocol === 'https:') {
    parsed.protocol = 'wss:'
  }
  parsed.pathname = `/v1/jupyter/kernels/${encodePathSegment(args.kernelId)}/channels`
  parsed.search = ''
  if (args.authorization && args.authorization.trim()) {
    parsed.searchParams.set('authorization', args.authorization.trim())
  }
  parsed.hash = ''
  return parsed.toString()
}

export async function getJupyterAuthorization(): Promise<string> {
  const authData = await getAuthData().catch(() => null)
  const token =
    authData?.idToken?.trim() ||
    getBrowserAdapter().simpleAuth?.idToken?.trim() ||
    ''
  return token ? `Bearer ${token}` : ''
}

class JupyterManager {
  private static singleton: JupyterManager | null = null
  private static readonly compositeKeySeparator = '\u001f'

  private version = 0
  private listeners = new Set<() => void>()
  private kernelsByRunner = new Map<string, KernelCacheEntry[]>()
  private kernelAliases = new Map<string, string>()
  private persistedKernelAliasesByKernel = new Map<string, string>()
  private ensureRunnerPromises = new Map<string, Promise<void>>()

  private constructor() {
    this.loadKernelAliasesFromStorage()
  }

  static getInstance(): JupyterManager {
    if (!JupyterManager.singleton) {
      JupyterManager.singleton = new JupyterManager()
    }
    return JupyterManager.singleton
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getVersion(): number {
    return this.version
  }

  private bumpVersion(): void {
    this.version += 1
    this.listeners.forEach((listener) => {
      try {
        listener()
      } catch (error) {
        console.error('Jupyter manager listener failed', error)
      }
    })
  }

  private normalizeRunnerName(runnerName: string): string {
    const mgr = getRunnersManager()
    const normalizedRunnerName = runnerName.trim()
    const effectiveName =
      normalizedRunnerName === DEFAULT_RUNNER_PLACEHOLDER
        ? (mgr.getDefaultRunnerName() ?? '')
        : normalizedRunnerName
    if (!effectiveName) {
      throw new Error('Runner name is required.')
    }
    return effectiveName
  }

  private resolveRunnerEndpoint(runnerName: string): string {
    const effectiveName = this.normalizeRunnerName(runnerName)
    const mgr = getRunnersManager()
    const runner = effectiveName
      ? mgr.getWithFallback(effectiveName)
      : undefined
    if (!runner?.endpoint) {
      throw new Error(`No runner endpoint configured for ${effectiveName}.`)
    }
    return runner.endpoint
  }

  private getAliasKey(runnerName: string, alias: string): string {
    return `${runnerName}${JupyterManager.compositeKeySeparator}${alias}`
  }

  private getKernelAliasKey(runnerName: string, kernelID: string): string {
    return `${runnerName}${JupyterManager.compositeKeySeparator}${kernelID}`
  }

  private parseKernelAliasKey(
    key: string
  ): { runnerName: string; kernelId: string } | null {
    const parts = key.split(JupyterManager.compositeKeySeparator)
    const runnerName = parts[0]
    const kernelId = parts.length === 2 ? parts[1] : parts[2]
    if (
      !runnerName ||
      !kernelId ||
      (parts.length !== 2 && parts.length !== 3)
    ) {
      return null
    }
    return { runnerName, kernelId }
  }

  private loadKernelAliasesFromStorage(): void {
    if (typeof window === 'undefined') {
      return
    }
    try {
      const raw = window.localStorage.getItem(KERNEL_ALIASES_STORAGE_KEY)
      if (!raw) {
        return
      }
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) {
        return
      }
      parsed.forEach((entry) => {
        if (
          entry &&
          typeof entry === 'object' &&
          typeof (entry as any).runnerName === 'string' &&
          typeof (entry as any).kernelId === 'string' &&
          typeof (entry as any).alias === 'string'
        ) {
          const runnerName = (entry as any).runnerName.trim()
          const kernelId = (entry as any).kernelId.trim()
          const alias = (entry as any).alias.trim()
          if (runnerName && kernelId && alias) {
            this.persistedKernelAliasesByKernel.set(
              this.getKernelAliasKey(runnerName, kernelId),
              alias
            )
          }
          return
        }
        // Backwards compatibility with old storage shape: { key, alias }.
        if (
          entry &&
          typeof entry === 'object' &&
          typeof (entry as any).key === 'string' &&
          typeof (entry as any).alias === 'string'
        ) {
          const key = (entry as any).key.trim()
          const alias = (entry as any).alias.trim()
          const parsedKey = this.parseKernelAliasKey(key)
          if (parsedKey && alias) {
            this.persistedKernelAliasesByKernel.set(
              this.getKernelAliasKey(parsedKey.runnerName, parsedKey.kernelId),
              alias
            )
          }
        }
      })
    } catch (error) {
      console.error('Failed to load Jupyter kernel aliases from storage', error)
    }
  }

  private persistKernelAliasesToStorage(): void {
    if (typeof window === 'undefined') {
      return
    }
    try {
      const serialized = [...this.persistedKernelAliasesByKernel.entries()].map(
        ([key, alias]) => ({
          ...(this.parseKernelAliasKey(key) ?? { key }),
          alias,
        })
      )
      window.localStorage.setItem(
        KERNEL_ALIASES_STORAGE_KEY,
        JSON.stringify(serialized)
      )
    } catch (error) {
      console.error(
        'Failed to persist Jupyter kernel aliases to storage',
        error
      )
    }
  }

  private setPersistedKernelAlias(
    runnerName: string,
    kernelID: string,
    alias: string
  ): void {
    const key = this.getKernelAliasKey(runnerName, kernelID)
    const trimmedAlias = alias.trim()
    if (!trimmedAlias) {
      this.persistedKernelAliasesByKernel.delete(key)
    } else {
      this.persistedKernelAliasesByKernel.set(key, trimmedAlias)
    }
    this.persistKernelAliasesToStorage()
  }

  private getPersistedKernelAlias(
    runnerName: string,
    kernelID: string
  ): string {
    return (
      this.persistedKernelAliasesByKernel.get(
        this.getKernelAliasKey(runnerName, kernelID)
      ) ?? ''
    )
  }

  private rebuildAliasLookupForRunner(
    runnerName: string,
    entries: KernelCacheEntry[]
  ): void {
    const prefix = `${runnerName}${JupyterManager.compositeKeySeparator}`
    for (const key of this.kernelAliases.keys()) {
      if (key.startsWith(prefix)) {
        this.kernelAliases.delete(key)
      }
    }
    entries.forEach((entry) => {
      const label = entry.label?.trim() ?? ''
      const modelName = entry.model.name?.trim() ?? ''
      if (
        !label ||
        normalizeKernelName(label) === normalizeKernelName(modelName)
      ) {
        return
      }
      this.kernelAliases.set(
        this.getAliasKey(runnerName, label),
        entry.model.id
      )
    })
  }

  private clearRunnerCache(runnerName: string): void {
    this.kernelsByRunner.delete(runnerName)
    for (const aliasKey of this.kernelAliases.keys()) {
      if (
        aliasKey.startsWith(
          `${runnerName}${JupyterManager.compositeKeySeparator}`
        )
      ) {
        this.kernelAliases.delete(aliasKey)
      }
    }
  }

  private async fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
    const authorization = await getJupyterAuthorization()
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers)
    if (authorization) {
      headers.set('Authorization', authorization)
    }
    let response: Response
    try {
      response = await fetch(url, {
        ...init,
        credentials: 'include',
        headers,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      appLogger.error('Jupyter request failed before receiving a response', {
        attrs: {
          scope: 'jupyter.fetch',
          method,
          url,
          hasAuthToken: Boolean(authorization),
          error: message,
        },
      })
      throw new Error(`Jupyter request failed (${method} ${url}): ${message}`)
    }
    if (!response.ok) {
      const text = await response.text()
      const bodyPreview = text.slice(0, 400)
      appLogger.error('Jupyter request returned non-success response', {
        attrs: {
          scope: 'jupyter.fetch',
          method,
          url,
          status: response.status,
          statusText: response.statusText,
          bodyPreview,
        },
      })
      throw new Error(
        `Jupyter request failed (${method} ${url}) with ${response.status} ${response.statusText}: ${
          bodyPreview || '<empty body>'
        }`
      )
    }
    if (response.status === 204 || response.status === 205) {
      return undefined as T
    }
    const text = await response.text()
    if (!text.trim()) {
      return undefined as T
    }
    try {
      return JSON.parse(text) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const bodyPreview = text.slice(0, 400)
      appLogger.error('Jupyter response was not valid JSON', {
        attrs: {
          scope: 'jupyter.fetch',
          method,
          url,
          error: message,
          bodyPreview,
        },
      })
      throw new Error(
        `Invalid JSON from Jupyter request (${method} ${url}): ${message}. Body: ${bodyPreview}`
      )
    }
  }

  private resolveDefaultRunnerName(): string {
    return getRunnersManager().getDefaultRunnerName() ?? ''
  }

  async ensureRunnerData(runnerName: string): Promise<void> {
    const requestedRunner = runnerName.trim()
    const effectiveRunner = requestedRunner || this.resolveDefaultRunnerName()
    if (!effectiveRunner) {
      return
    }
    const existing = this.ensureRunnerPromises.get(effectiveRunner)
    if (existing) {
      await existing
      return
    }
    const promise = this.listKernels(effectiveRunner)
      .then(() => undefined)
      .finally(() => {
        this.ensureRunnerPromises.delete(effectiveRunner)
      })
    this.ensureRunnerPromises.set(effectiveRunner, promise)
    await promise
  }

  async listKernels(runnerName: string): Promise<JupyterKernelModel[]> {
    const effectiveRunner = this.normalizeRunnerName(runnerName)
    const baseURL = runnerEndpointToHttpBase(
      this.resolveRunnerEndpoint(effectiveRunner)
    )
    const kernels = await this.fetchJSON<JupyterKernelModel[]>(
      `${baseURL}/v1/jupyter/kernels`
    )
    const existingLabels = new Map<string, string>()
    ;(this.kernelsByRunner.get(effectiveRunner) ?? []).forEach((entry) => {
      existingLabels.set(entry.model.id, entry.label)
    })
    const next = kernels.map((model) => {
      const aliasLabel =
        existingLabels.get(model.id) ||
        this.getPersistedKernelAlias(effectiveRunner, model.id)
      const label =
        aliasLabel && aliasLabel.trim() ? aliasLabel : model.name || model.id
      return { model, label }
    })
    this.clearRunnerCache(effectiveRunner)
    this.kernelsByRunner.set(effectiveRunner, next)
    this.rebuildAliasLookupForRunner(effectiveRunner, next)
    this.bumpVersion()
    return kernels
  }

  async startKernel(
    runnerName: string,
    options?: JupyterKernelStartOptions
  ): Promise<JupyterKernelModel> {
    const effectiveRunner = this.normalizeRunnerName(runnerName)
    const baseURL = runnerEndpointToHttpBase(
      this.resolveRunnerEndpoint(effectiveRunner)
    )
    const alias = options?.name?.trim() ?? ''
    if (alias) {
      const existing = await this.listKernels(effectiveRunner)
      const requestedKey = normalizeKernelName(alias)
      const duplicate = existing.find((kernel) => {
        if (normalizeKernelName(kernel.name || '') === requestedKey) {
          return true
        }
        const cached = this.kernelsByRunner.get(effectiveRunner) ?? []
        const cacheHit = cached.find((entry) => entry.model.id === kernel.id)
        return normalizeKernelName(cacheHit?.label || '') === requestedKey
      })
      if (duplicate) {
        throw new Error(
          `Kernel alias "${alias}" already exists on ${effectiveRunner}.`
        )
      }
    }

    const payload: Record<string, unknown> = {}
    if (options?.kernelSpec?.trim()) {
      payload.name = options.kernelSpec.trim()
    }
    const kernel = await this.fetchJSON<JupyterKernelModel>(
      `${baseURL}/v1/jupyter/kernels`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }
    )

    const label = alias || kernel.name || kernel.id
    if (alias) {
      this.setPersistedKernelAlias(effectiveRunner, kernel.id, alias)
    } else {
      this.setPersistedKernelAlias(effectiveRunner, kernel.id, '')
    }
    const existing = this.kernelsByRunner.get(effectiveRunner) ?? []
    const filtered = existing.filter((entry) => entry.model.id !== kernel.id)
    filtered.push({
      model: kernel,
      label,
    })
    this.kernelsByRunner.set(effectiveRunner, filtered)
    this.rebuildAliasLookupForRunner(effectiveRunner, filtered)
    this.bumpVersion()
    return kernel
  }

  async getKernel(
    runnerName: string,
    kernelID: string
  ): Promise<JupyterKernelModel> {
    const effectiveRunner = this.normalizeRunnerName(runnerName)
    if (!kernelID.trim()) {
      throw new Error('Kernel ID is required.')
    }
    const baseURL = runnerEndpointToHttpBase(
      this.resolveRunnerEndpoint(effectiveRunner)
    )
    return this.fetchJSON<JupyterKernelModel>(
      `${baseURL}/v1/jupyter/kernels/${encodePathSegment(kernelID)}`
    )
  }

  async stopKernel(runnerName: string, kernelNameOrId: string): Promise<void> {
    const effectiveRunner = this.normalizeRunnerName(runnerName)
    const kernelID = await this.resolveKernelID(effectiveRunner, kernelNameOrId)
    if (!kernelID) {
      throw new Error(`Kernel ${kernelNameOrId} was not found.`)
    }
    const baseURL = runnerEndpointToHttpBase(
      this.resolveRunnerEndpoint(effectiveRunner)
    )
    await this.fetchJSON<unknown>(
      `${baseURL}/v1/jupyter/kernels/${encodePathSegment(kernelID)}`,
      {
        method: 'DELETE',
      }
    )
    const existing = this.kernelsByRunner.get(effectiveRunner) ?? []
    const remaining = existing.filter((entry) => entry.model.id !== kernelID)
    this.kernelsByRunner.set(effectiveRunner, remaining)
    this.setPersistedKernelAlias(effectiveRunner, kernelID, '')
    this.rebuildAliasLookupForRunner(effectiveRunner, remaining)
    this.bumpVersion()
  }

  async interruptKernel(
    runnerName: string,
    kernelID: string,
    options?: { signal?: AbortSignal }
  ): Promise<void> {
    const effectiveRunner = this.normalizeRunnerName(runnerName)
    if (!kernelID.trim()) {
      throw new Error('Kernel ID is required.')
    }
    const baseURL = runnerEndpointToHttpBase(
      this.resolveRunnerEndpoint(effectiveRunner)
    )
    await this.fetchJSON<unknown>(
      `${baseURL}/v1/jupyter/kernels/${encodePathSegment(kernelID)}/interrupt`,
      {
        method: 'POST',
        signal: options?.signal,
      }
    )
  }

  async restartKernel(
    runnerName: string,
    kernelID: string
  ): Promise<JupyterKernelModel> {
    const effectiveRunner = this.normalizeRunnerName(runnerName)
    if (!kernelID.trim()) {
      throw new Error('Kernel ID is required.')
    }
    const baseURL = runnerEndpointToHttpBase(
      this.resolveRunnerEndpoint(effectiveRunner)
    )
    const kernel = await this.fetchJSON<JupyterKernelModel>(
      `${baseURL}/v1/jupyter/kernels/${encodePathSegment(kernelID)}/restart`,
      { method: 'POST' }
    )
    const existing = this.kernelsByRunner.get(effectiveRunner) ?? []
    const next = existing.map((entry) =>
      entry.model.id === kernel.id ? { ...entry, model: kernel } : entry
    )
    this.kernelsByRunner.set(effectiveRunner, next)
    this.bumpVersion()
    return kernel
  }

  async resolveKernelID(
    runnerName: string,
    kernelNameOrId: string
  ): Promise<string> {
    const effectiveRunner = this.normalizeRunnerName(runnerName)
    const trimmed = kernelNameOrId.trim()
    if (!trimmed) {
      return ''
    }
    const aliasID = this.kernelAliases.get(
      this.getAliasKey(effectiveRunner, trimmed)
    )
    if (aliasID) {
      return aliasID
    }
    const cached = this.kernelsByRunner.get(effectiveRunner) ?? []
    const fromCached =
      cached.find((entry) => entry.model.id === trimmed)?.model.id ??
      cached.find((entry) => entry.label === trimmed)?.model.id ??
      cached.find((entry) => entry.model.name === trimmed)?.model.id
    if (fromCached) {
      return fromCached
    }
    await this.listKernels(effectiveRunner)
    const refreshed = this.kernelsByRunner.get(effectiveRunner) ?? []
    return (
      refreshed.find((entry) => entry.model.id === trimmed)?.model.id ??
      refreshed.find((entry) => entry.label === trimmed)?.model.id ??
      refreshed.find((entry) => entry.model.name === trimmed)?.model.id ??
      ''
    )
  }

  getKernelOptionsForRunner(runnerName: string): JupyterKernelOption[] {
    const resolvedRunner = this.normalizeRunnerName(runnerName)
    const options = (this.kernelsByRunner.get(resolvedRunner) ?? []).map(
      (entry) => {
        const kernelID = entry.model.id
        const label = entry.label || entry.model.name || kernelID
        return {
          key: this.getKernelOptionKey(resolvedRunner, kernelID),
          label,
          runnerName: resolvedRunner,
          kernelId: kernelID,
          kernelName: entry.model.name || label,
        }
      }
    )
    options.sort((a, b) => a.label.localeCompare(b.label))
    return options
  }

  parseKernelOptionKey(
    key: string
  ): { runnerName: string; kernelId: string } | null {
    if (!key || !key.includes(':')) {
      return null
    }
    const [runnerEncoded, kernelEncoded, ...rest] = key.split(':')
    if (!runnerEncoded || !kernelEncoded || rest.length > 0) {
      return null
    }
    return {
      runnerName: decodePathSegment(runnerEncoded),
      kernelId: decodePathSegment(kernelEncoded),
    }
  }

  getKernelOptionKey(runnerName: string, kernelId: string): string {
    return `${encodePathSegment(runnerName)}:${encodePathSegment(kernelId)}`
  }
}

export function getJupyterManager(): JupyterManager {
  return JupyterManager.getInstance()
}
