import {
  CaptureUpdateAction,
  Excalidraw,
  restore,
  serializeAsJSON,
} from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppState,
  BinaryFiles,
  ExcalidrawInitialDataState,
  ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'

import { appLogger } from '../../lib/logging/runtime'
import { appState } from '../../lib/runtime/AppState'
import type { WorkspaceDocument } from '../../lib/workspaceDocuments/workspaceDocumentTypes'
import {
  EXCALIDRAW_MIME_TYPE,
  createInitialExcalidrawDocumentJson,
} from '../../storage/excalidraw'

type SaveState = 'loading' | 'ready' | 'saving' | 'saved' | 'error'

export default function ExcalidrawDocument({
  document,
}: {
  document: WorkspaceDocument
}) {
  const remoteUri = useMemo(
    () => document.requestedUri?.trim() || '',
    [document.requestedUri, document.uri]
  )
  const localUri = useMemo(
    () => (document.uri.startsWith('local://file/') ? document.uri : ''),
    [document.uri]
  )
  const [initialData, setInitialData] =
    useState<ExcalidrawInitialDataState | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('loading')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const latestJsonRef = useRef<string>('')
  const lastSavedJsonRef = useRef<string>('')
  const excalidrawApiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const applyingExternalUpdateRef = useRef(false)

  const flushSave = useCallback(
    async (options: { updateState?: boolean } = {}) => {
      const updateState = options.updateState ?? true
      const json = latestJsonRef.current
      if (!json || json === lastSavedJsonRef.current) {
        return
      }
      const localStore = appState.localNotebooks
      const driveStore = appState.driveNotebookStore
      if (!localStore && (!driveStore || !remoteUri)) {
        if (updateState) {
          setSaveState('error')
          setErrorMessage('Excalidraw document storage is not initialized')
        }
        return
      }

      if (updateState) {
        setSaveState('saving')
      }
      try {
        if (localStore && localUri) {
          await localStore.saveContent(localUri, json, EXCALIDRAW_MIME_TYPE)
        } else if (driveStore && remoteUri) {
          await driveStore.saveContent(remoteUri, json, EXCALIDRAW_MIME_TYPE)
        }
        lastSavedJsonRef.current = json
        if (updateState) {
          setSaveState('saved')
          setErrorMessage(null)
        }
      } catch (error) {
        appLogger.error('Failed to save Excalidraw document', {
          attrs: {
            scope: 'excalidraw.drive',
            uri: document.uri,
            remoteUri,
            error: String(error),
          },
        })
        if (updateState) {
          setSaveState('error')
          setErrorMessage(String(error))
        }
      }
    },
    [document.uri, localUri, remoteUri]
  )

  const restoreSerializedScene = useCallback((raw: string) => {
    const json = raw.trim() ? raw : createInitialExcalidrawDocumentJson()
    const parsed = JSON.parse(json)
    const restored = restore(parsed, null, null)
    const normalizedJson = serializeAsJSON(
      restored.elements,
      restored.appState,
      restored.files,
      'local'
    )
    return { restored, normalizedJson }
  }, [])

  useEffect(() => {
    let cancelled = false
    setInitialData(null)
    setSaveState('loading')
    setErrorMessage(null)
    latestJsonRef.current = ''
    lastSavedJsonRef.current = ''

    void (async () => {
      const localStore = appState.localNotebooks

      let raw: string
      if (localStore && localUri) {
        raw = await localStore.loadContent(localUri)
      } else if (remoteUri) {
        const driveStore = appState.driveNotebookStore
        if (!driveStore) {
          throw new Error('Google Drive store is not initialized')
        }
        raw = await driveStore.loadContent(remoteUri)
      } else {
        throw new Error('Excalidraw document storage is not initialized')
      }
      const { restored, normalizedJson } = restoreSerializedScene(raw)
      if (cancelled) {
        return
      }
      lastSavedJsonRef.current = normalizedJson
      latestJsonRef.current = normalizedJson
      setInitialData(restored)
      setSaveState('ready')
    })().catch((error) => {
      appLogger.error('Failed to load Excalidraw document', {
        attrs: {
          scope: 'excalidraw.drive',
          uri: document.uri,
          remoteUri,
          error: String(error),
        },
      })
      if (!cancelled) {
        setErrorMessage(String(error))
        setSaveState('error')
      }
    })

    return () => {
      cancelled = true
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      void flushSave({ updateState: false })
    }
  }, [document.uri, flushSave, localUri, remoteUri, restoreSerializedScene])

  useEffect(() => {
    if (!localUri) {
      return
    }
    const localStore = appState.localNotebooks
    if (!localStore) {
      return
    }

    const refreshFromLocalStore = () => {
      void (async () => {
        const raw = await localStore.loadContent(localUri)
        const { restored, normalizedJson } = restoreSerializedScene(raw)
        if (normalizedJson === latestJsonRef.current) {
          return
        }
        if (saveTimerRef.current !== null) {
          window.clearTimeout(saveTimerRef.current)
          saveTimerRef.current = null
        }
        applyingExternalUpdateRef.current = true
        latestJsonRef.current = normalizedJson
        lastSavedJsonRef.current = normalizedJson
        setInitialData(restored)
        const api = excalidrawApiRef.current
        if (api) {
          const files = Object.values(restored.files ?? {})
          if (files.length > 0) {
            api.addFiles(files)
          }
          api.updateScene({
            elements: restored.elements,
            appState: restored.appState,
            captureUpdate: CaptureUpdateAction.NEVER,
          })
        }
        setSaveState('saved')
        setErrorMessage(null)
        window.setTimeout(() => {
          applyingExternalUpdateRef.current = false
        }, 0)
      })().catch((error) => {
        appLogger.error('Failed to refresh Excalidraw document from local store', {
          attrs: {
            scope: 'excalidraw.drive',
            uri: document.uri,
            remoteUri,
            error: String(error),
          },
        })
        applyingExternalUpdateRef.current = false
        setSaveState('error')
        setErrorMessage(String(error))
      })
    }

    const unsubscribe = localStore.subscribeSync(localUri, refreshFromLocalStore)
    return unsubscribe
  }, [document.uri, localUri, remoteUri, restoreSerializedScene])

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void flushSave()
    }, 800)
  }, [flushSave])

  const handleChange = useCallback(
    (
      elements: readonly ExcalidrawElement[],
      sceneAppState: AppState,
      files: BinaryFiles
    ) => {
      const json = serializeAsJSON(elements, sceneAppState, files, 'local')
      latestJsonRef.current = json
      if (applyingExternalUpdateRef.current) {
        lastSavedJsonRef.current = json
        return
      }
      if (json !== lastSavedJsonRef.current) {
        setSaveState('ready')
        scheduleSave()
      }
    },
    [scheduleSave]
  )

  if (saveState === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <div className="text-sm font-medium text-nb-text">
          Could not open Excalidraw diagram
        </div>
        <div className="max-w-xl text-xs text-nb-error">
          {errorMessage ?? 'Unknown error'}
        </div>
      </div>
    )
  }

  if (saveState === 'loading' || !initialData) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-nb-text-muted">
        Loading Excalidraw diagram...
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-nb-border bg-nb-surface px-3 text-xs text-nb-text-muted">
        <span className="truncate">{document.title}</span>
        <span data-testid="excalidraw-save-status">
          {saveState === 'saving'
            ? 'Saving...'
            : saveState === 'saved'
              ? 'Saved'
              : 'Ready'}
        </span>
      </div>
      <div
        className="min-h-0 flex-1"
        data-testid="excalidraw-document-canvas"
      >
        <Excalidraw
          key={document.uri}
          excalidrawAPI={(api) => {
            excalidrawApiRef.current = api
          }}
          initialData={initialData}
          name={document.title}
          onChange={handleChange}
          UIOptions={{
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
            },
          }}
        />
      </div>
    </div>
  )
}
