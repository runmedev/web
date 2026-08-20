import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LinkedResourceError } from './linkedResource'
import {
  recordLinkedResourceCacheHit,
  recordLinkedResourceDownloadLatency,
  recordLinkedResourceEviction,
  recordLinkedResourceFallbackUse,
  recordLinkedResourceUploadFailure,
} from './linkedResourceMetrics'
import { appLogger } from './logging/runtime'

describe('linked resource metrics', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('records privacy-safe transfer and cache dimensions', () => {
    const info = vi
      .spyOn(appLogger, 'info')
      .mockImplementation(() => null as never)

    recordLinkedResourceUploadFailure(
      new LinkedResourceError(
        'UPLOAD_INTERRUPTED',
        'Bearer secret-token failed for https://drive.google.com/file/d/private'
      )
    )
    recordLinkedResourceDownloadLatency(12.6, 'opfs')
    recordLinkedResourceCacheHit()
    recordLinkedResourceEviction(4096, 2)
    recordLinkedResourceFallbackUse()

    expect(info).toHaveBeenCalledTimes(5)
    expect(info).toHaveBeenNthCalledWith(1, 'Linked resource metric', {
      attrs: {
        scope: 'linked-resource.metric',
        metric: 'upload_failure',
        errorCode: 'UPLOAD_INTERRUPTED',
      },
    })
    expect(info).toHaveBeenNthCalledWith(2, 'Linked resource metric', {
      attrs: {
        scope: 'linked-resource.metric',
        metric: 'download_latency',
        durationMs: 13,
        source: 'opfs',
      },
    })
    expect(info.mock.calls).not.toContainEqual(
      expect.arrayContaining([expect.stringContaining('secret-token')])
    )
    expect(JSON.stringify(info.mock.calls)).not.toContain('drive.google.com')
  })
})
