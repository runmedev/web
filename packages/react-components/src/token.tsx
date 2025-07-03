import {
  OAuthToken,
  OAuthTokenSchema,
} from '@buf/stateful_runme.bufbuild_es/agent/credentials_pb'
import { fromJson } from '@bufbuild/protobuf'
import { create } from '@bufbuild/protobuf'

export const SESSION_COOKIE_NAMES = ['agent-session', 'cassie-session']
export const OAUTH_COOKIE_NAMES = ['agent-oauth-token', 'cassie-oauth-token']

// Returns the value of the session token cookie, or undefined if not found
export function getSessionToken(): string | undefined {
  for (const name of SESSION_COOKIE_NAMES) {
    const match = document.cookie
      .split('; ')
      .find((row) => row.startsWith(name + '='))
    const value = match?.split('=')[1]
    if (value && value.length > 0) {
      return value
    }
  }
  return undefined
}

// Returns the value of the oauth access token.
export function getAccessToken(): OAuthToken {
  let token: OAuthToken = create(OAuthTokenSchema)
  for (const name of OAUTH_COOKIE_NAMES) {
    const match = document.cookie
      .split('; ')
      .find((row) => row.startsWith(name + '='))
    const value = match?.split('=')[1]
    if (value && value.length > 0) {
      try {
        // Unescape the URL-encoded value
        const jsonStr = decodeURIComponent(value)
        // Parse the string into an object
        const parsed = JSON.parse(jsonStr)
        // Parse the payload into a Protobuf message
        token = fromJson(OAuthTokenSchema, parsed)
        return token
      } catch (err) {
        console.error('Failed to parse OAuthToken:', err)
      }
    }
  }
  return token
}
