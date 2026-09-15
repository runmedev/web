export type OAuthTokenEndpointResponse = {
  access_token: string
  id_token?: string
  refresh_token?: string
  token_type?: string
  scope?: string
  expires_in?: number
}

export type StoredTokenResponse = OAuthTokenEndpointResponse & {
  expires_at?: number
  loginFlow?: 'pkce' | 'implicit'
  loginInteraction?: 'redirect' | 'popup' | 'new_tab'
}

export type SimpleAuthJSONWithHelpers = {
  accessToken: string
  idToken?: string
  refreshToken?: string
  tokenType?: string
  scope?: string
  expiresAt?: number
  loginFlow?: 'pkce' | 'implicit'
  loginInteraction?: 'redirect' | 'popup' | 'new_tab'
  isExpired: () => boolean
  willExpireSoon: (thresholdSeconds?: number) => boolean
}
