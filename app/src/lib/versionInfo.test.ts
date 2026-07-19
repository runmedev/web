import { describe, expect, it } from 'vitest'

import {
  formatRunmeVersionYaml,
  hasRunmeVersionInfo,
  normalizeRunmeVersionInfo,
} from './versionInfo'

describe('versionInfo', () => {
  it('normalizes build env into version.yaml fields', () => {
    const info = normalizeRunmeVersionInfo({
      VITE_RUNME_VERSION_BUILD_DATE: ' 2026-06-03T12:00:00Z ',
      VITE_RUNME_VERSION_WEB_REPO: 'runmedev/web',
      VITE_RUNME_VERSION_WEB_BRANCH: 'main',
      VITE_RUNME_VERSION_WEB_COMMIT: 'web-sha',
      VITE_RUNME_VERSION_BUCKET: 'gs://runme-hosted',
    })

    expect(hasRunmeVersionInfo(info)).toBe(true)
    expect(formatRunmeVersionYaml(info)).toBe(
      [
        'buildDate: 2026-06-03T12:00:00Z',
        'webRepo: runmedev/web',
        'webBranch: main',
        'webCommit: web-sha',
        'bucket: gs://runme-hosted',
      ].join('\n')
    )
  })

  it('treats missing build env as unavailable metadata', () => {
    const info = normalizeRunmeVersionInfo({})

    expect(hasRunmeVersionInfo(info)).toBe(false)
    expect(formatRunmeVersionYaml(info)).toContain('webCommit: ')
  })
})
