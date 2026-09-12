import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  formatRunmeVersionYaml,
  hasRunmeVersionInfo,
  normalizeRunmeVersionInfo,
} from './versionInfo'

describe('versionInfo', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('reports loaded build metadata and isolates callers from mutation', async () => {
    vi.stubEnv('VITE_RUNME_VERSION_BUILD_DATE', '2026-09-11T22:01:42Z')
    vi.stubEnv('VITE_RUNME_VERSION_WEB_REPO', 'runmedev/web')
    vi.stubEnv('VITE_RUNME_VERSION_WEB_BRANCH', 'main')
    vi.stubEnv('VITE_RUNME_VERSION_WEB_COMMIT', '805b4bc')
    vi.stubEnv('VITE_RUNME_VERSION_BUCKET', 'gs://runme-hosted')
    vi.resetModules()
    const { getRunmeVersionInfo } = await import('./versionInfo')
    const expected = {
      buildDate: '2026-09-11T22:01:42Z',
      webRepo: 'runmedev/web',
      webBranch: 'main',
      webCommit: '805b4bc',
      bucket: 'gs://runme-hosted',
    }
    const version = getRunmeVersionInfo()
    expect(version).toEqual(expected)
    version.webCommit = 'changed-by-caller'
    // A later deployment/config change must not identify this already loaded bundle.
    vi.stubEnv('VITE_RUNME_VERSION_WEB_COMMIT', 'new-deployment')
    expect(getRunmeVersionInfo()).toEqual(expected)
  })

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
