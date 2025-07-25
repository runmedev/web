import { OAuthTokenSchema } from '@buf/stateful_runme.bufbuild_es/agent/v1/credentials_pb'
import { create, toJsonString } from '@bufbuild/protobuf'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  OAUTH_COOKIE_NAMES,
  SESSION_COOKIE_NAMES,
  getAccessToken,
  getSessionToken,
} from '../token'

describe('token utilities', () => {
  beforeEach(() => {
    // Clear cookies before each test
    document.cookie = ''
    vi.clearAllMocks()
  })

  afterEach(() => {
    // Clear cookies after each test
    document.cookie = ''
  })

  describe('getSessionToken', () => {
    it('returns undefined when no session cookies are present', () => {
      expect(getSessionToken()).toBeUndefined()
    })

    it('returns session token when agent-session cookie is present', () => {
      document.cookie = 'agent-session=test-token'
      expect(getSessionToken()).toBe('test-token')
    })

    it('returns session token when cassie-session cookie is present', () => {
      document.cookie = 'cassie-session=test-token'
      expect(getSessionToken()).toBe('test-token')
    })

    it('prefers agent-session over cassie-session', () => {
      document.cookie = 'agent-session=agent-token; cassie-session=cassie-token'
      expect(getSessionToken()).toBe('agent-token')
    })

    it('handles empty cookie values', () => {
      // Set a valid cookie first, then try to set an empty one
      document.cookie = 'agent-session=test-token;'
      document.cookie = 'agent-session=;'
      expect(getSessionToken()).toBe('test-token')
    })

    it('handles malformed cookies', () => {
      // Set a valid cookie first, then try to set a malformed one
      document.cookie = 'agent-session=test-token;'
      document.cookie = 'agent-session;'
      expect(getSessionToken()).toBe('test-token')
    })
  })

  describe('getAccessToken', () => {
    it('returns default token when no oauth cookies are present', () => {
      const token = getAccessToken()
      expect(token).toEqual(
        create(OAuthTokenSchema, {
          accessToken: '',
          expiresAt: 0n,
          expiresIn: 0n,
          refreshToken: '',
          tokenType: '',
        })
      )
    })

    it('returns parsed token when agent-oauth-token cookie is present', async () => {
      const mockToken = create(OAuthTokenSchema, {
        accessToken: 'test-access-token',
      })

      document.cookie =
        'agent-oauth-token=' +
        encodeURIComponent(toJsonString(OAuthTokenSchema, mockToken))

      const token = getAccessToken()
      expect(token).toEqual(mockToken)
    })

    it('returns parsed token when cassie-oauth-token cookie is present', async () => {
      const mockToken = create(OAuthTokenSchema, {
        accessToken: 'test-access-token',
      })

      const v = encodeURIComponent(toJsonString(OAuthTokenSchema, mockToken))
      document.cookie = 'cassie-oauth-token=' + v

      const token = getAccessToken()
      expect(token).toEqual(mockToken)
    })

    it('handles invalid JSON in cookie', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      // Set a valid cookie first, then try to set an invalid one
      document.cookie =
        'agent-oauth-token=' +
        encodeURIComponent(JSON.stringify({ access_token: 'test' })) +
        ';'
      document.cookie = 'agent-oauth-token=invalid-json;'

      const token = getAccessToken()
      expect(token).toEqual(
        create(OAuthTokenSchema, {
          $typeName: 'agent.v1.OAuthToken',
          accessToken: 'test-access-token',
          expiresAt: 0n,
          expiresIn: 0n,
          refreshToken: '',
          tokenType: '',
        })
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to parse OAuthToken:',
        expect.any(Error)
      )

      consoleSpy.mockRestore()
    })
  })

  describe('constants', () => {
    it('exports correct session cookie names', () => {
      expect(SESSION_COOKIE_NAMES).toEqual(['agent-session', 'cassie-session'])
    })

    it('exports correct oauth cookie names', () => {
      expect(OAUTH_COOKIE_NAMES).toEqual([
        'agent-oauth-token',
        'cassie-oauth-token',
      ])
    })
  })
})
