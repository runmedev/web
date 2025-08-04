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

    // New tests for improved reliability
    it('handles cookies with different separators', () => {
      document.cookie = 'agent-session=test-token;other-cookie=value'
      expect(getSessionToken()).toBe('test-token')
    })

    it('handles cookies with extra whitespace', () => {
      document.cookie =
        '  agent-session  =  test-token  ;  other-cookie  =  value  '
      expect(getSessionToken()).toBe('test-token')
    })

    it('handles URL-encoded cookie values', () => {
      document.cookie =
        'agent-session=' + encodeURIComponent('test-token with spaces')
      expect(getSessionToken()).toBe('test-token with spaces')
    })

    it('avoids false positives with similar cookie names', () => {
      // Clear cookies first
      document.cookie = ''
      // Set cookies with proper separation
      document.cookie = 'agent-session-extra=wrong-token'
      document.cookie = 'agent-session=correct-token'
      expect(getSessionToken()).toBe('correct-token')
    })

    it('handles cookies without values', () => {
      // Clear all cookies by setting them to expire
      document.cookie = 'agent-session=; expires=Thu, 01 Jan 1970 00:00:00 GMT'
      document.cookie = 'cassie-session=; expires=Thu, 01 Jan 1970 00:00:00 GMT'
      // Set a cookie without a value
      document.cookie = 'agent-session='
      expect(getSessionToken()).toBeUndefined()
    })

    it('handles malformed cookies without equals sign', () => {
      document.cookie =
        'agent-session=test-token;malformed-cookie;other-cookie=value'
      expect(getSessionToken()).toBe('test-token')
    })
  })

  describe('getAccessToken', () => {
    it('returns empty token when no oauth cookies are present', () => {
      const token = getAccessToken()
      expect(token).toEqual('')
    })

    it('returns parsed token when agent-oauth-token cookie is present', async () => {
      const mockToken = create(OAuthTokenSchema, {
        accessToken: 'test-access-token',
      })

      document.cookie =
        'agent-oauth-token=' +
        encodeURIComponent(toJsonString(OAuthTokenSchema, mockToken))

      const token = getAccessToken()
      expect(token).toEqual(mockToken.accessToken)
    })

    it('returns parsed token when cassie-oauth-token cookie is present', async () => {
      const mockToken = create(OAuthTokenSchema, {
        accessToken: 'test-access-token',
      })

      const v = encodeURIComponent(toJsonString(OAuthTokenSchema, mockToken))
      document.cookie = 'cassie-oauth-token=' + v

      const token = getAccessToken()
      expect(token).toEqual(mockToken.accessToken)
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
      // TODO(jlewi): I'm not sure why the value ends up being test-access-token.
      expect(token).toEqual('test-access-token')
      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to parse OAuthToken:',
        expect.any(Error)
      )

      consoleSpy.mockRestore()
    })

    // New tests for improved reliability
    it('handles OAuth tokens with URL-encoded JSON', () => {
      const mockToken = create(OAuthTokenSchema, {
        accessToken: 'test-access-token with spaces',
      })

      const jsonString = toJsonString(OAuthTokenSchema, mockToken)
      document.cookie = 'agent-oauth-token=' + encodeURIComponent(jsonString)

      const token = getAccessToken()
      expect(token).toBe('test-access-token with spaces')
    })

    it('handles malformed OAuth cookies gracefully', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      // Clear all OAuth cookies by setting them to expire
      document.cookie =
        'agent-oauth-token=; expires=Thu, 01 Jan 1970 00:00:00 GMT'
      document.cookie =
        'cassie-oauth-token=; expires=Thu, 01 Jan 1970 00:00:00 GMT'
      // Set a malformed cookie that should be ignored
      document.cookie = 'agent-oauth-token=invalid-json'

      const token = getAccessToken()
      expect(token).toEqual('')

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
