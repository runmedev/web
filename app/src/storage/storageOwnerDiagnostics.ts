import type { releaseDatabaseDiagnostics } from '../releases/releaseDiagnostics'

/** Diagnostics bypass store initialization and never include notebook contents or credentials. */
export type StorageOwnerDiagnostics = {
  release?: { releaseId: string; epoch: number; capabilities: string[] }
  version: number
  instanceId: string
  uptimeMs: number
  connectedTabs: number
  initialization: 'pending' | 'ready' | 'failed'
  pendingCredentials: number
  scanning: boolean
  recovery: 'idle' | 'preparing' | 'draining'
  activeRequestCount: number
  releaseDatabase?: ReturnType<typeof releaseDatabaseDiagnostics>
  restart?: {
    stage: string
    elapsedMs: number
    readyTabs: number
    connectedTabs: number
    inFlight: number
  }
  oldestRequests: {
    method: string
    elapsedMs: number
    stage: string
    stageElapsedMs?: number
  }[]
}
