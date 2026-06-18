export const EXCALIDRAW_MIME_TYPE = 'application/vnd.excalidraw+json'

export type ExcalidrawDocumentMetadata = {
  name?: string
  mimeType?: string
}

export function isExcalidrawFileName(name: string | undefined): boolean {
  return /\.(excalidraw|excalidraw\.json)$/i.test((name ?? '').trim())
}

export function isExcalidrawMimeType(mimeType: string | undefined): boolean {
  return (mimeType ?? '').trim().toLowerCase() === EXCALIDRAW_MIME_TYPE
}

export function isExcalidrawDocumentMetadata(
  item: ExcalidrawDocumentMetadata | null | undefined
): boolean {
  return isExcalidrawMimeType(item?.mimeType) || isExcalidrawFileName(item?.name)
}

export function createInitialExcalidrawDocumentJson(): string {
  return JSON.stringify(
    {
      type: 'excalidraw',
      version: 2,
      source: 'runme',
      elements: [],
      appState: {
        viewBackgroundColor: '#ffffff',
      },
      files: {},
    },
    null,
    2
  )
}
