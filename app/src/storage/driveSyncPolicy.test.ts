import { describe, expect, it } from 'vitest'

import {
  UnsupportedDriveSyncError,
  driveSyncErrorText,
  isNativeDriveFile,
  isPermanentDriveSyncError,
} from './driveSyncPolicy'

const conversion =
  'Drive request failed (400 ): ' +
  JSON.stringify({
    error: {
      code: 400,
      errors: [{ reason: 'conversionUnsupportedConversionPath' }],
    },
  })

describe('Drive sync retry policy', () => {
  it('recognizes current and previously persisted conversion failures', () => {
    expect(isPermanentDriveSyncError(new Error(conversion))).toBe(true)
    expect(isPermanentDriveSyncError(String(new Error(conversion)))).toBe(true)
    expect(
      isPermanentDriveSyncError(String(new UnsupportedDriveSyncError()))
    ).toBe(true)
  })
  it('retains a conversion error wrapped by creation across restart', () => {
    const wrapped = Object.assign(
      new Error('Drive rejected create before committing'),
      { cause: new Error(conversion) }
    )
    expect(isPermanentDriveSyncError(wrapped)).toBe(true)
    expect(isPermanentDriveSyncError(driveSyncErrorText(wrapped))).toBe(true)
    expect(driveSyncErrorText(wrapped)).toContain(conversion)
    const cyclic = Object.assign(new Error('offline'), {
      cause: undefined as unknown,
    })
    cyclic.cause = cyclic
    expect(isPermanentDriveSyncError(cyclic)).toBe(false)
  })
  it.each([
    undefined,
    'offline',
    'unauthorized',
    'Drive request failed (429 ): quota',
    'Drive request failed (503 ): unavailable',
    'Drive request failed (400 ): malformed',
    'Drive request failed (400 ): {"error":{"errors":[{"reason":"other"}]}}',
    'Drive request failed (400 ): {"error":{"errors":{}}}',
    'conversionUnsupportedConversionPath',
    conversion.replace('(400 ', '(500 '),
  ])('does not suppress recoverable or unknown failures: %s', (error) => {
    expect(isPermanentDriveSyncError(error)).toBe(false)
  })
  it('excludes native Workspace files, including shortcuts, while retaining normal files', () => {
    expect(isNativeDriveFile('application/vnd.google-apps.document')).toBe(true)
    expect(isNativeDriveFile('application/vnd.google-apps.shortcut')).toBe(true)
    expect(isNativeDriveFile('application/json')).toBe(false)
    expect(isNativeDriveFile('text/markdown')).toBe(false)
    expect(isNativeDriveFile(undefined)).toBe(false)
  })
})
