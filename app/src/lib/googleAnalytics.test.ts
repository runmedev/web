import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  GoogleAnalyticsClient,
  type GoogleAnalyticsClientOptions,
  classifyNotebookAnalyticsSource,
} from './googleAnalytics'

const validOptions = (
  overrides: Partial<GoogleAnalyticsClientOptions> = {}
): GoogleAnalyticsClientOptions => ({
  measurementId: 'G-TEST123',
  hostname: 'web.runme.dev',
  doNotTrack: null,
  globalPrivacyControl: false,
  document,
  globalObject: {},
  ...overrides,
})

afterEach(() => {
  document.getElementById('runme-google-analytics')?.remove()
})

describe('classifyNotebookAnalyticsSource', () => {
  it.each([
    ['local://file/secret-id', 'local'],
    ['fs://workspace/private/notebook.json', 'local'],
    ['https://drive.google.com/file/d/private-id/view', 'google_drive'],
    ['https://example.com/private/path?token=secret', 'http'],
    ['not a uri', 'unknown'],
  ] as const)('collapses %s to %s', (uri, expected) => {
    expect(classifyNotebookAnalyticsSource(uri)).toBe(expected)
  })
})

describe('GoogleAnalyticsClient', () => {
  it.each([
    ['missing ID', { measurementId: undefined }],
    ['invalid ID', { measurementId: '123456789' }],
    ['non-production host', { hostname: 'localhost' }],
    ['Do Not Track', { doNotTrack: '1' }],
    ['Global Privacy Control', { globalPrivacyControl: true }],
  ] as const)('stays disabled for %s', (_name, overrides) => {
    const globalObject = {}
    const client = new GoogleAnalyticsClient(
      validOptions({ ...overrides, globalObject })
    )

    expect(client.initialize()).toBe(false)
    expect(globalObject).toEqual({})
    expect(document.getElementById('runme-google-analytics')).toBeNull()
  })

  it('initializes once with privacy-preserving configuration', () => {
    const globalObject: { dataLayer?: Array<ArrayLike<unknown>> } = {}
    const client = new GoogleAnalyticsClient(validOptions({ globalObject }))

    expect(client.initialize()).toBe(true)
    expect(client.initialize()).toBe(true)

    const script = document.getElementById(
      'runme-google-analytics'
    ) as HTMLScriptElement
    expect(script).toBeTruthy()
    expect(script.async).toBe(true)
    expect(script.referrerPolicy).toBe('no-referrer')
    expect(script.src).toBe(
      'https://www.googletagmanager.com/gtag/js?id=G-TEST123'
    )
    expect(document.querySelectorAll('#runme-google-analytics')).toHaveLength(1)

    const commands = globalObject.dataLayer?.map((command) =>
      Array.from(command)
    )
    expect(commands).toHaveLength(2)
    expect(commands?.[0]?.[0]).toBe('js')
    expect(commands?.[0]?.[1]).toBeInstanceOf(Date)
    expect(commands?.[1]).toEqual([
      'config',
      'G-TEST123',
      {
        allow_ad_personalization_signals: false,
        allow_google_signals: false,
        send_page_view: false,
        page_location: 'https://web.runme.dev/',
        page_referrer: '',
        page_title: 'Runme Web',
      },
    ])
  })

  it('emits only the allowlisted event payloads and safe page context', () => {
    const globalObject: { dataLayer?: Array<ArrayLike<unknown>> } = {}
    const client = new GoogleAnalyticsClient(validOptions({ globalObject }))
    client.initialize()

    client.trackNotebookOpened({
      notebookSource: 'google_drive',
      accessMode: 'read_only',
    })
    client.trackCellExecuted({ executionBackend: 'jupyter' })

    const events = globalObject.dataLayer
      ?.slice(2)
      .map((command) => Array.from(command))
    expect(events).toEqual([
      [
        'event',
        'notebook_opened',
        {
          access_mode: 'read_only',
          notebook_source: 'google_drive',
          page_location: 'https://web.runme.dev/',
          page_referrer: '',
          page_title: 'Runme Web',
        },
      ],
      [
        'event',
        'cell_executed',
        {
          execution_backend: 'jupyter',
          page_location: 'https://web.runme.dev/',
          page_referrer: '',
          page_title: 'Runme Web',
        },
      ],
    ])
  })

  it('contains analytics failures inside the client', () => {
    const gtag = vi.fn(() => {
      throw new Error('analytics unavailable')
    })
    const client = new GoogleAnalyticsClient(
      validOptions({ globalObject: { gtag } })
    )

    expect(() => client.initialize()).not.toThrow()
    expect(client.initialize()).toBe(false)
    expect(() =>
      client.trackCellExecuted({ executionBackend: 'runner' })
    ).not.toThrow()
  })
})
