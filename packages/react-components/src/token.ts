import {
  OAuthToken,
  OAuthTokenSchema,
} from '@buf/stateful_runme.bufbuild_es/agent/v1/credentials_pb'
import { fromJson } from '@bufbuild/protobuf'
import { create } from '@bufbuild/protobuf'
import Cookies from 'js-cookie'

export const SESSION_COOKIE_NAMES = ['agent-session', 'cassie-session']
export const OAUTH_COOKIE_NAMES = ['agent-oauth-token', 'cassie-oauth-token']

// Returns the value of the session token cookie, or undefined if not found
export function getSessionToken(): string | undefined {
  for (const name of SESSION_COOKIE_NAMES) {
    const value = Cookies.get(name)
    if (value && value.length > 0) {
      return value
    }
  }
  return undefined
}

// Returns the value of the oauth access token.
export function getAccessToken(): string {
  let token: OAuthToken = create(OAuthTokenSchema)
  for (const name of OAUTH_COOKIE_NAMES) {
    const value = Cookies.get(name)
    if (value && value.length > 0) {
      try {
        // Parse the string into an object (js-cookie handles URL decoding automatically)
        const parsed = JSON.parse(value)
        // Parse the payload into a Protobuf message
        token = fromJson(OAuthTokenSchema, parsed)
        return token.accessToken
      } catch (err) {
        console.error('Failed to parse OAuthToken:', err)
      }
    }
  }
  return token.accessToken
}
