import { useCallback, useEffect, useMemo, useState } from 'react'

import { useGoogleAuth } from '../../contexts/GoogleAuthContext'
import {
  type LinkedResourceErrorCode,
  type LinkedResourceRenderer,
  type LinkedResourceV1,
  LinkedResourceError,
  linkedResourceTitle,
  parseLinkedResource,
  selectLinkedResourceRenderer,
} from '../../lib/linkedResource'
import { getLinkedResourceCache } from '../../lib/linkedResourceCache'
import { appState } from '../../lib/runtime/AppState'
import type { parser_pb } from '../../runme/client'
import type { DriveResourceMetadata } from '../../storage/drive'

type LoadState =
  | { status: 'loading'; progress?: number }
  | {
      status: 'ready'
      metadata?: DriveResourceMetadata
      objectUrl?: string
      renderer: LinkedResourceRenderer
    }
  | {
      status: 'error'
      code: LinkedResourceErrorCode
      message: string
      metadata?: DriveResourceMetadata
    }

function formatBytes(value?: number): string | null {
  if (value === undefined || !Number.isFinite(value)) {
    return null
  }
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`
}

function errorCode(error: unknown): LinkedResourceErrorCode {
  return error instanceof LinkedResourceError
    ? error.code
    : 'PROVIDER_UNAVAILABLE'
}

function LinkCard({
  resource,
  metadata,
  status,
  actions,
}: {
  resource: LinkedResourceV1
  metadata?: DriveResourceMetadata
  status?: string
  actions?: React.ReactNode
}) {
  const size = formatBytes(metadata?.sizeBytes ?? resource.hints?.sizeBytes)
  return (
    <div className="rounded-nb-md border border-nb-border bg-white p-4 shadow-sm">
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="min-w-0">
          <a
            className="break-words font-medium text-nb-accent hover:underline"
            href={resource.source.uri}
            target="_blank"
            rel="noreferrer"
          >
            {linkedResourceTitle(resource)}
          </a>
          <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-nb-text-muted">
            <span>
              {resource.source.provider === 'google-drive'
                ? 'Google Drive'
                : 'HTTPS'}
            </span>
            {(metadata?.mimeType ?? resource.hints?.mimeType) && (
              <span>{metadata?.mimeType ?? resource.hints?.mimeType}</span>
            )}
            {size && <span>{size}</span>}
          </div>
          {status && (
            <p className="mt-2 text-sm text-nb-text-muted">{status}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
      </div>
    </div>
  )
}

export default function ResourceCell({ cell }: { cell: parser_pb.Cell }) {
  const { ensureAccessToken, isDriveSyncing } = useGoogleAuth()
  const [reload, setReload] = useState(0)
  const resourceResult = useMemo(() => {
    try {
      return { resource: parseLinkedResource(cell.value) } as const
    } catch (error) {
      return { error } as const
    }
  }, [cell.value])
  const resource = 'resource' in resourceResult ? resourceResult.resource : null
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    if (!resource) {
      return
    }
    if (resource.source.provider === 'https') {
      const renderer =
        resource.presentation.mode === 'image' ||
        resource.presentation.mode === 'video' ||
        resource.presentation.mode === 'audio'
          ? resource.presentation.mode
          : 'link'
      setState({ status: 'ready', renderer })
      return
    }

    const driveStore = appState.driveNotebookStore
    if (!driveStore) {
      setState({
        status: 'error',
        code: 'PROVIDER_UNAVAILABLE',
        message: 'Google Drive storage is not initialized.',
      })
      return
    }
    const abortController = new AbortController()
    let activeObjectUrl: string | undefined
    let releaseCachePin: (() => void) | undefined
    setState({ status: 'loading' })
    void (async () => {
      try {
        const metadata = await driveStore.getResourceMetadata(
          resource.source.uri
        )
        if (abortController.signal.aborted) {
          return
        }
        const renderer = selectLinkedResourceRenderer(
          metadata.mimeType,
          resource.presentation.mode
        )
        if (renderer === 'link' || renderer === 'document') {
          setState({ status: 'ready', metadata, renderer })
          return
        }
        const cache = getLinkedResourceCache()
        const cached = await cache.load(driveStore, metadata, {
          signal: abortController.signal,
          onProgress: (downloaded, total) => {
            if (!abortController.signal.aborted) {
              setState({
                status: 'loading',
                progress: total ? downloaded / total : undefined,
              })
            }
          },
        })
        if (cached.cacheKey) {
          releaseCachePin = cache.pin(cached.cacheKey)
        }
        if (abortController.signal.aborted) {
          return
        }
        activeObjectUrl = URL.createObjectURL(cached.file)
        setState({
          status: 'ready',
          metadata,
          renderer,
          objectUrl: activeObjectUrl,
        })
      } catch (error) {
        if (!abortController.signal.aborted) {
          setState({
            status: 'error',
            code: errorCode(error),
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
    })()
    return () => {
      abortController.abort()
      if (activeObjectUrl) {
        URL.revokeObjectURL(activeObjectUrl)
      }
      releaseCachePin?.()
    }
  }, [isDriveSyncing, reload, resource])

  const handleSignIn = useCallback(() => {
    void ensureAccessToken({ interactive: true })
      .then(() => setReload((value) => value + 1))
      .catch((error) => {
        setState({
          status: 'error',
          code: 'AUTH_REQUIRED',
          message: error instanceof Error ? error.message : String(error),
        })
      })
  }, [ensureAccessToken])

  if (!resource) {
    return (
      <div className="rounded-nb-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Invalid linked resource: {String(resourceResult.error)}
      </div>
    )
  }

  if (state.status === 'loading') {
    const progress =
      state.progress === undefined
        ? 'Loading linked resource…'
        : `Downloading… ${Math.round(state.progress * 100)}%`
    return <LinkCard resource={resource} status={progress} />
  }

  if (state.status === 'error') {
    const authRequired = state.code === 'AUTH_REQUIRED'
    const accessDenied = state.code === 'ACCESS_DENIED'
    return (
      <LinkCard
        resource={resource}
        metadata={state.metadata}
        status={state.message}
        actions={
          <>
            {authRequired && (
              <button type="button" className="btn" onClick={handleSignIn}>
                Sign in to load
              </button>
            )}
            {accessDenied && (
              <a
                className="btn"
                href={resource.source.uri}
                target="_blank"
                rel="noreferrer"
              >
                Request access
              </a>
            )}
            <a
              className="btn"
              href={resource.source.uri}
              target="_blank"
              rel="noreferrer"
            >
              Open in Drive
            </a>
          </>
        }
      />
    )
  }

  const src = state.objectUrl ?? resource.source.uri
  if (state.renderer === 'image') {
    return (
      <img
        className="max-h-[70vh] max-w-full rounded-nb-md object-contain"
        src={src}
        alt={resource.presentation.altText ?? linkedResourceTitle(resource)}
      />
    )
  }
  if (state.renderer === 'video') {
    return (
      <video
        className="max-h-[70vh] w-full rounded-nb-md bg-black"
        src={src}
        controls
        playsInline
        preload="metadata"
        loop={resource.presentation.loop}
        muted={resource.presentation.muted}
      />
    )
  }
  if (state.renderer === 'audio') {
    return <audio className="w-full" src={src} controls preload="metadata" />
  }
  return (
    <LinkCard
      resource={resource}
      metadata={state.metadata}
      status={
        state.renderer === 'document'
          ? 'Document preview is not enabled; open the file in Drive.'
          : !state.metadata?.canDownload
            ? 'Download is restricted by Google Drive.'
            : undefined
      }
      actions={
        <a
          className="btn"
          href={resource.source.uri}
          target="_blank"
          rel="noreferrer"
        >
          Open in Drive
        </a>
      }
    />
  )
}
