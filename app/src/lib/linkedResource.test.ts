import { describe, expect, it } from 'vitest'

import {
  LINKED_RESOURCE_LANGUAGE_ID,
  canonicalGoogleDriveFileUrl,
  createLinkedResourceCell,
  linkedResourceMarkdown,
  parseGoogleDriveFileId,
  parseLinkedResource,
  selectLinkedResourceRenderer,
} from './linkedResource'

const driveResource = {
  version: 1 as const,
  source: {
    provider: 'google-drive' as const,
    uri: 'https://drive.google.com/file/d/file_123/view?usp=sharing',
  },
  presentation: {
    mode: 'auto' as const,
    title: 'Demo recording',
  },
  hints: {
    name: 'demo.webm',
    mimeType: 'video/webm',
    sizeBytes: 1024,
  },
}

describe('linked resources', () => {
  it('validates and canonicalizes Drive resources', () => {
    const parsed = parseLinkedResource(JSON.stringify(driveResource))
    expect(parsed.source.uri).toBe(
      'https://drive.google.com/file/d/file_123/view'
    )
    expect(parseGoogleDriveFileId(parsed.source.uri)).toBe('file_123')
    expect(canonicalGoogleDriveFileUrl('file_123')).toBe(parsed.source.uri)
  })

  it('preserves a Drive resource key while removing unrelated share params', () => {
    const parsed = parseLinkedResource(
      JSON.stringify({
        ...driveResource,
        source: {
          provider: 'google-drive',
          uri: 'https://drive.google.com/file/d/file_123/view?usp=sharing&resourcekey=key_123',
        },
      })
    )
    expect(parsed.source.uri).toBe(
      'https://drive.google.com/file/d/file_123/view?resourcekey=key_123'
    )
    expect(canonicalGoogleDriveFileUrl('file_123', 'key_123')).toBe(
      parsed.source.uri
    )
  })

  it('rejects unknown versions and unsafe URI schemes', () => {
    expect(() =>
      parseLinkedResource(JSON.stringify({ ...driveResource, version: 2 }))
    ).toThrow('Unsupported linked resource version')
    expect(() =>
      parseLinkedResource(
        JSON.stringify({
          ...driveResource,
          source: { provider: 'https', uri: 'javascript:alert(1)' },
        })
      )
    ).toThrow('HTTPS')
  })

  it('rejects malformed Drive file IDs', () => {
    expect(() =>
      parseGoogleDriveFileId('https://drive.google.com/drive/folders/folder')
    ).toThrow('file ID')
    expect(() =>
      parseGoogleDriveFileId('https://example.com/file/d/file_123/view')
    ).toThrow('drive.google.com')
  })

  it('builds a non-runnable resource cell and portable Markdown link', () => {
    const cell = createLinkedResourceCell(driveResource)
    expect(cell.languageId).toBe(LINKED_RESOURCE_LANGUAGE_ID)
    expect(cell.metadata['runme.dev/linkedResource']).toBe('true')
    expect(linkedResourceMarkdown(parseLinkedResource(cell.value))).toBe(
      '[Demo recording](https://drive.google.com/file/d/file_123/view)'
    )
    expect(cell.value).not.toContain('Bearer')
  })

  it('selects renderers only from safe authoritative MIME types', () => {
    expect(selectLinkedResourceRenderer('image/gif')).toBe('image')
    expect(selectLinkedResourceRenderer('video/webm')).toBe('video')
    expect(selectLinkedResourceRenderer('audio/mpeg')).toBe('audio')
    expect(selectLinkedResourceRenderer('application/pdf')).toBe('document')
    expect(selectLinkedResourceRenderer('image/svg+xml')).toBe('link')
    expect(selectLinkedResourceRenderer('text/html', 'video')).toBe('link')
    expect(selectLinkedResourceRenderer('video/webm', 'image')).toBe('link')
  })
})
