import { create } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../runme/client'
import {
  MAX_EMBEDDED_IMAGE_BYTES,
  buildEmbeddedImageHtml,
  embedImageInNotebook,
  isSupportedImageFile,
  pickImageFromLocalFilesystem,
  readEmbeddedImageSource,
} from './imageEmbedding'
import type { NotebookDataLike } from './runtime/runmeConsole'

function createNotebook(): NotebookDataLike {
  const notebook = create(parser_pb.NotebookSchema, { cells: [] })
  return {
    getUri: () => 'local://file/images',
    getName: () => 'images.json',
    getNotebook: () => notebook,
    getCell: () => null,
    updateCell: (cell) => {
      const index = notebook.cells.findIndex(
        (candidate) => candidate.refId === cell.refId
      )
      notebook.cells[index] = create(parser_pb.CellSchema, cell)
    },
    appendCell: (kind = parser_pb.CellKind.CODE, languageId) => {
      const cell = create(parser_pb.CellSchema, {
        refId: `cell-${notebook.cells.length + 1}`,
        kind,
        languageId: languageId ?? 'bash',
        value: '',
        metadata: {},
      })
      notebook.cells.push(cell)
      return cell
    },
    removeCell: (refId) => {
      notebook.cells = notebook.cells.filter((cell) => cell.refId !== refId)
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (window as any).showOpenFilePicker
})

describe('image embedding', () => {
  it('builds escaped, responsive image HTML', () => {
    const html = buildEmbeddedImageHtml(
      {
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: 'image/png',
        name: 'chart.png',
      },
      { alt: '"<& chart' }
    )

    expect(html).toContain('src="data:image/png;base64,AQID"')
    expect(html).toContain('alt="&quot;&lt;&amp; chart"')
    expect(html).toContain('max-width:100%')
  })

  it('embeds a Blob in a non-runnable HTML cell', async () => {
    const notebook = createNotebook()
    const blob = new Blob([new Uint8Array([137, 80, 78, 71])], {
      type: 'image/png',
    })

    const result = await embedImageInNotebook(notebook, blob, {
      name: 'screenshot.png',
      alt: 'Screenshot',
    })

    expect(result.uri).toBe('local://file/images')
    expect(result.cell.kind).toBe(parser_pb.CellKind.CODE)
    expect(result.cell.languageId).toBe('html')
    expect(result.cell.value).toContain('data:image/png;base64,iVBORw==')
    expect(result.cell.metadata).toMatchObject({
      'runme.dev/embeddedImage': 'true',
      'runme.dev/embeddedImageMimeType': 'image/png',
      'runme.dev/embeddedImageName': 'screenshot.png',
    })
    expect(notebook.getNotebook().cells).toHaveLength(1)
  })

  it('reads an absolute image path through the local development endpoint', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('/__runme-dev/local-image')
      expect(url).toContain('path=%2Ftmp%2Fscreenshot.png')
      return new Response(new Uint8Array([1, 2]), {
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': '2',
        },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const image = await readEmbeddedImageSource('/tmp/screenshot.png')

    expect(image).toMatchObject({
      mimeType: 'image/png',
      name: 'screenshot.png',
    })
    expect(Array.from(image.bytes)).toEqual([1, 2])
  })

  it('rejects non-image responses and oversized images', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response('not an image', {
          headers: { 'Content-Type': 'text/plain' },
        })
      })
    )
    await expect(
      readEmbeddedImageSource('https://example.com/file.txt')
    ).rejects.toThrow('Unsupported image type')

    const oversized = new Blob([new Uint8Array(MAX_EMBEDDED_IMAGE_BYTES + 1)], {
      type: 'image/png',
    })
    await expect(readEmbeddedImageSource(oversized)).rejects.toThrow(
      'Image is too large'
    )
  })

  it('stops streaming a response when it exceeds the image limit', async () => {
    const cancel = vi.fn()
    let chunkIndex = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const size =
          chunkIndex++ === 0 ? MAX_EMBEDDED_IMAGE_BYTES - 1024 : 1025
        controller.enqueue(new Uint8Array(size))
      },
      cancel,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(stream, {
          headers: { 'Content-Type': 'image/png' },
        })
      })
    )

    await expect(
      readEmbeddedImageSource('https://example.com/oversized.png')
    ).rejects.toThrow('Image is too large')
    expect(cancel).toHaveBeenCalled()
  })

  it('bounds error response details without reading the full body', async () => {
    const cancel = vi.fn(async () => undefined)
    const releaseLock = vi.fn()
    const read = vi.fn(async () => ({
      done: false,
      value: new TextEncoder().encode(
        `server failed: ${'x'.repeat(5 * 1024)}`
      ),
    }))
    const text = vi.fn(async () => {
      throw new Error('unbounded response.text() should not be called')
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          headers: new Headers({ 'Content-Type': 'text/plain' }),
          body: {
            getReader: () => ({ read, cancel, releaseLock }),
          },
          text,
        } as unknown as Response
      })
    )

    await expect(
      readEmbeddedImageSource('https://example.com/failure.png')
    ).rejects.toThrow('Failed to read image (500): server failed:')
    expect(read).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalled()
    expect(releaseLock).toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
  })

  it('uses the native image picker and recognizes extension-only images', async () => {
    const file = new File([new Uint8Array([1])], 'diagram.png', { type: '' })
    ;(window as any).showOpenFilePicker = vi.fn(async () => [
      {
        getFile: async () => file,
      },
    ])

    await expect(pickImageFromLocalFilesystem()).resolves.toBe(file)
    expect(isSupportedImageFile(file)).toBe(true)
    expect(
      isSupportedImageFile(
        new File([new Uint8Array([1])], 'notes.txt', { type: 'text/plain' })
      )
    ).toBe(false)
  })
})
