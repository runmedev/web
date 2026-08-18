// @vitest-environment jsdom
import { create } from '@bufbuild/protobuf'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../../runme/client'

const mocks = vi.hoisted(() => ({
  cacheLoad: vi.fn(),
  cachePin: vi.fn(),
  releaseCachePin: vi.fn(),
  ensureAccessToken: vi.fn(),
  driveStore: {
    getResourceMetadata: vi.fn(),
  },
}))

vi.mock('../../contexts/GoogleAuthContext', () => ({
  useGoogleAuth: () => ({
    ensureAccessToken: mocks.ensureAccessToken,
    isDriveSyncing: true,
  }),
}))

vi.mock('../../lib/linkedResourceCache', () => ({
  getLinkedResourceCache: () => ({
    load: mocks.cacheLoad,
    pin: mocks.cachePin,
  }),
}))

vi.mock('../../lib/runtime/AppState', () => ({
  appState: { driveNotebookStore: mocks.driveStore },
}))

import ResourceCell from './ResourceCell'

function resourceCell(
  provider: 'google-drive' | 'https',
  uri: string,
  mode: 'auto' | 'image' | 'video' | 'audio' | 'document' | 'link' = 'auto'
) {
  return create(parser_pb.CellSchema, {
    refId: 'resource-1',
    kind: parser_pb.CellKind.CODE,
    languageId: 'runme-resource',
    value: JSON.stringify({
      version: 1,
      source: { provider, uri },
      presentation: { mode, title: 'Demo resource' },
    }),
  })
}

describe('ResourceCell', () => {
  const createObjectURL = vi.fn(() => 'blob:runme-resource')
  const revokeObjectURL = vi.fn()

  beforeEach(() => {
    mocks.cacheLoad.mockReset()
    mocks.cachePin.mockReset()
    mocks.releaseCachePin.mockReset()
    mocks.cachePin.mockReturnValue(mocks.releaseCachePin)
    mocks.ensureAccessToken.mockReset()
    mocks.driveStore.getResourceMetadata.mockReset()
    createObjectURL.mockClear()
    revokeObjectURL.mockClear()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders an explicitly requested HTTPS video without autoplay', () => {
    render(
      <ResourceCell
        cell={resourceCell('https', 'https://example.com/demo.webm', 'video')}
      />
    )

    const video = document.querySelector('video')
    expect(video).not.toBeNull()
    expect(video?.getAttribute('src')).toBe('https://example.com/demo.webm')
    expect(video?.hasAttribute('controls')).toBe(true)
    expect(video?.hasAttribute('autoplay')).toBe(false)
    expect(mocks.cacheLoad).not.toHaveBeenCalled()
  })

  it('degrades active Drive content to a link without downloading it', async () => {
    mocks.driveStore.getResourceMetadata.mockResolvedValue({
      uri: 'https://drive.google.com/file/d/file-123/view',
      name: 'unsafe.js',
      mimeType: 'application/javascript',
      sizeBytes: 12,
      canDownload: true,
      md5Checksum: 'version-1',
    })

    render(
      <ResourceCell
        cell={resourceCell(
          'google-drive',
          'https://drive.google.com/file/d/file-123/view'
        )}
      />
    )

    expect(
      await screen.findByRole('link', { name: 'Demo resource' })
    ).toBeTruthy()
    expect(document.querySelector('script')).toBeNull()
    expect(mocks.cacheLoad).not.toHaveBeenCalled()
  })

  it('revokes the object URL when downloaded media is unmounted', async () => {
    const metadata = {
      uri: 'https://drive.google.com/file/d/file-123/view',
      name: 'demo.webm',
      mimeType: 'video/webm',
      sizeBytes: 4,
      canDownload: true,
      md5Checksum: 'version-1',
    }
    mocks.driveStore.getResourceMetadata.mockResolvedValue(metadata)
    mocks.cacheLoad.mockResolvedValue({
      file: new Blob([new Uint8Array([1, 2, 3, 4])], {
        type: 'video/webm',
      }),
      metadata,
      principalKey: 'principal-key',
      source: 'memory',
      cacheKey: 'cache-key',
    })

    const view = render(
      <ResourceCell
        cell={resourceCell(
          'google-drive',
          'https://drive.google.com/file/d/file-123/view'
        )}
      />
    )

    await waitFor(() => {
      expect(document.querySelector('video')?.getAttribute('src')).toBe(
        'blob:runme-resource'
      )
    })
    view.unmount()

    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:runme-resource')
    expect(mocks.cachePin).toHaveBeenCalledWith('cache-key')
    expect(mocks.releaseCachePin).toHaveBeenCalledOnce()
  })
})
