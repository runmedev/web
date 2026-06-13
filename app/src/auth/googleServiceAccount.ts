import type { OAuthTokenEndpointResponse } from './types'

export type GoogleServiceAccountCredentials = {
  clientEmail: string
  privateKey: string
  privateKeyId?: string
  tokenUri?: string
  subject?: string
  scopes?: string[]
}

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token'
const JWT_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
const DEFAULT_EXPIRES_IN = 3600

type GoogleTokenErrorResponse = {
  error?: string
  error_description?: string
}

function assertBrowserEncodingSupport(): void {
  if (typeof globalThis.btoa !== 'function') {
    throw new Error('Google service account auth requires btoa support.')
  }
  if (typeof globalThis.atob !== 'function') {
    throw new Error('Google service account auth requires atob support.')
  }
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  assertBrowserEncodingSupport()
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return globalThis
    .btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncodeBytes(
    new TextEncoder().encode(JSON.stringify(value))
  )
}

function decodePemPrivateKey(privateKey: string): Uint8Array {
  assertBrowserEncodingSupport()
  const normalizedKey = privateKey.replace(/\\n/g, '\n')
  const base64 = normalizedKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '')

  if (!base64) {
    throw new Error('Google service account private_key is empty.')
  }

  const binary = globalThis.atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

async function importPrivateKey(privateKey: string): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Google service account auth requires Web Crypto support.')
  }

  return globalThis.crypto.subtle.importKey(
    'pkcs8',
    decodePemPrivateKey(privateKey),
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['sign']
  )
}

export async function createGoogleServiceAccountJwt(
  credentials: GoogleServiceAccountCredentials,
  scopes: string[],
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<string> {
  const clientEmail = credentials.clientEmail.trim()
  const privateKey = credentials.privateKey.trim()
  const resolvedScopes =
    credentials.scopes && credentials.scopes.length > 0
      ? credentials.scopes
      : scopes
  const scope = resolvedScopes.map((item) => item.trim()).filter(Boolean)
  const tokenUri = credentials.tokenUri?.trim() || DEFAULT_TOKEN_URI

  if (!clientEmail) {
    throw new Error('Google service account config is missing client_email.')
  }
  if (!privateKey) {
    throw new Error('Google service account config is missing private_key.')
  }
  if (scope.length === 0) {
    throw new Error('Google service account auth requires at least one scope.')
  }

  const header: Record<string, string> = {
    alg: 'RS256',
    typ: 'JWT',
  }
  if (credentials.privateKeyId?.trim()) {
    header.kid = credentials.privateKeyId.trim()
  }

  const claimSet: Record<string, string | number> = {
    iss: clientEmail,
    scope: scope.join(' '),
    aud: tokenUri,
    iat: nowSeconds,
    exp: nowSeconds + DEFAULT_EXPIRES_IN,
  }
  if (credentials.subject?.trim()) {
    claimSet.sub = credentials.subject.trim()
  }

  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(
    claimSet
  )}`
  const key = await importPrivateKey(privateKey)
  const signature = await globalThis.crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  )

  return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`
}

export async function mintGoogleServiceAccountAccessToken(
  credentials: GoogleServiceAccountCredentials,
  scopes: string[]
): Promise<OAuthTokenEndpointResponse> {
  const tokenUri = credentials.tokenUri?.trim() || DEFAULT_TOKEN_URI
  const assertion = await createGoogleServiceAccountJwt(credentials, scopes)
  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: JWT_GRANT_TYPE,
      assertion,
    }),
  })

  let token: Partial<OAuthTokenEndpointResponse> &
    GoogleTokenErrorResponse = {}
  try {
    token = (await response.json()) as Partial<OAuthTokenEndpointResponse> &
      GoogleTokenErrorResponse
  } catch {
    token = {}
  }

  if (!response.ok || token.error || !token.access_token) {
    throw new Error(
      token.error_description ??
        token.error ??
        `Google service account token exchange failed (${response.status})`
    )
  }

  return {
    access_token: token.access_token,
    token_type: token.token_type,
    scope: token.scope,
    expires_in: token.expires_in ?? DEFAULT_EXPIRES_IN,
  }
}
