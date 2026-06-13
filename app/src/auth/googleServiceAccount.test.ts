import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createGoogleServiceAccountJwt,
  mintGoogleServiceAccountAccessToken,
  type GoogleServiceAccountCredentials,
} from './googleServiceAccount'

function base64UrlDecodeJson(value: string): Record<string, unknown> {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(globalThis.atob(base64))
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return globalThis.btoa(binary)
}

async function generatePrivateKeyPem(): Promise<string> {
  const keyPair = await globalThis.crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  )
  const pkcs8 = await globalThis.crypto.subtle.exportKey(
    'pkcs8',
    keyPair.privateKey
  )
  const base64 = bytesToBase64(new Uint8Array(pkcs8))
  const lines = base64.match(/.{1,64}/g) ?? []
  return [
    '-----BEGIN PRIVATE KEY-----',
    ...lines,
    '-----END PRIVATE KEY-----',
  ].join('\n')
}

describe('Google service account auth', () => {
  let credentials: GoogleServiceAccountCredentials

  beforeEach(async () => {
    vi.restoreAllMocks()
    credentials = {
      clientEmail: 'runme-drive-test@example.iam.gserviceaccount.com',
      privateKey: await generatePrivateKeyPem(),
      privateKeyId: 'test-key-id',
      tokenUri: 'https://oauth2.googleapis.com/token',
    }
  })

  it('creates a JWT bearer assertion with Drive scopes', async () => {
    const jwt = await createGoogleServiceAccountJwt(
      credentials,
      ['https://www.googleapis.com/auth/drive'],
      1_700_000_000
    )

    const [headerRaw, claimsRaw, signatureRaw] = jwt.split('.')

    expect(headerRaw).toBeTruthy()
    expect(claimsRaw).toBeTruthy()
    expect(signatureRaw).toBeTruthy()
    expect(base64UrlDecodeJson(headerRaw)).toMatchObject({
      alg: 'RS256',
      typ: 'JWT',
      kid: 'test-key-id',
    })
    expect(base64UrlDecodeJson(claimsRaw)).toMatchObject({
      iss: 'runme-drive-test@example.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/drive',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    })
  })

  it('exchanges the JWT assertion for an access token', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: 'service-account-access-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const token = await mintGoogleServiceAccountAccessToken(credentials, [
      'https://www.googleapis.com/auth/drive',
    ])

    expect(token.access_token).toBe('service-account-access-token')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const requestBody = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams
    expect(requestBody.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:jwt-bearer'
    )
    expect(requestBody.get('assertion')?.split('.')).toHaveLength(3)
  })
})
