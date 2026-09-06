import { afterEach, describe, expect, it, vi } from 'vitest'

import { commentAttributionLabel } from './commentAttribution'
import { resolveCommentIdentity } from './commentIdentity'
import { normalizeAttribution } from './operationLog/reviews'

afterEach(() => vi.unstubAllGlobals())

describe('comment attribution provenance', () => {
  it('identifies an impersonated service account without claiming a human author', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          user: {
            displayName: 'Runme service',
            emailAddress: 'runme@example.iam.gserviceaccount.com',
            permissionId: 'gsa-id',
          },
        }),
      }))
    )
    const author = await resolveCommentIdentity(
      async () => 'service-account-token'
    )
    expect(author).toEqual({
      displayName: 'Runme service',
      kind: 'service-account',
      source: 'google-drive',
      authenticatedPrincipal: 'gsa-id',
    })
    expect(
      commentAttributionLabel({
        runmeAuthorKind: author.kind,
        runmeAuthorSource: author.source,
        runmeAuthenticatedPrincipal: author.authenticatedPrincipal,
      })
    ).toBe('service account · Google Drive identity')
    expect(normalizeAttribution(author)).toEqual({
      displayName: 'Runme service',
      kind: 'service-account',
    })
  })
  it('looks up the active token for each UI submission without relabeling earlier authors', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          user: { displayName: 'Ada', permissionId: 'ada' },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          user: { displayName: 'Grace', permissionId: 'grace' },
        }),
      })
    vi.stubGlobal('fetch', fetcher)
    const first = await resolveCommentIdentity(async () => 'account-one')
    const second = await resolveCommentIdentity(async () => 'account-two')
    expect(first).toEqual({
      displayName: 'Ada',
      kind: 'human',
      source: 'google-drive',
      authenticatedPrincipal: 'ada',
    })
    expect(second.displayName).toBe('Grace')
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe(
      'Bearer account-one'
    )
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBe(
      'Bearer account-two'
    )
  })

  it('falls back to unknown for unavailable, signed-out, or changed identities', async () => {
    const unknown = { displayName: 'unknown', kind: 'unknown' }
    expect(await resolveCommentIdentity()).toEqual(unknown)
    expect(
      await resolveCommentIdentity(async () => {
        throw new Error('signed out')
      })
    ).toEqual(unknown)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          user: { displayName: 'Ada', permissionId: 'ada' },
        }),
      }))
    )
    expect(
      await resolveCommentIdentity(
        async () => 'token',
        () => false
      )
    ).toEqual(unknown)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false }))
    )
    expect(await resolveCommentIdentity(async () => 'token')).toEqual(unknown)
  })

  it('strips API-supplied verification claims and distinguishes recorded labels', () => {
    expect(
      normalizeAttribution({
        displayName: 'Ada',
        kind: 'human',
        source: 'google-drive',
        authenticatedPrincipal: 'fake',
      })
    ).toEqual({ displayName: 'Ada', kind: 'human' })
    expect(commentAttributionLabel({ runmeAuthorKind: 'human' })).toBe(
      'human · supplied attribution'
    )
    expect(commentAttributionLabel({ runmeAuthorKind: 'agent' })).toBe(
      'agent · supplied attribution'
    )
    expect(
      commentAttributionLabel({
        runmeAuthorKind: 'human',
        runmeAuthorSource: 'google-drive',
        runmeAuthenticatedPrincipal: 'ada',
      })
    ).toBe('human · Google Drive identity')
    expect(commentAttributionLabel({ displayName: 'Historical user' })).toBe('')
  })
})
