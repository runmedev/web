import { LinkedResourceError } from './linkedResource'
import { appLogger } from './logging/runtime'

type CacheSource = 'opfs' | 'memory'

function emitLinkedResourceMetric(
  metric: string,
  attrs: Record<string, string | number>
): void {
  appLogger.info('Linked resource metric', {
    attrs: {
      scope: 'linked-resource.metric',
      metric,
      ...attrs,
    },
  })
}

function errorCode(error: unknown): string {
  if (error instanceof LinkedResourceError) {
    return error.code
  }
  if (error instanceof DOMException) {
    return error.name || 'DOM_EXCEPTION'
  }
  return 'UNKNOWN'
}

export function recordLinkedResourceUploadFailure(error: unknown): void {
  emitLinkedResourceMetric('upload_failure', { errorCode: errorCode(error) })
}

export function recordLinkedResourceDownloadLatency(
  durationMs: number,
  source: CacheSource
): void {
  emitLinkedResourceMetric('download_latency', {
    durationMs: Math.max(0, Math.round(durationMs)),
    source,
  })
}

export function recordLinkedResourceCacheHit(): void {
  emitLinkedResourceMetric('cache_hit', { source: 'opfs' })
}

export function recordLinkedResourceEviction(
  evictedBytes: number,
  evictedEntries: number
): void {
  emitLinkedResourceMetric('cache_eviction', {
    evictedBytes: Math.max(0, Math.round(evictedBytes)),
    evictedEntries: Math.max(0, Math.round(evictedEntries)),
  })
}

export function recordLinkedResourceFallbackUse(): void {
  emitLinkedResourceMetric('fallback_use', { reason: 'opfs_unavailable' })
}
