import assert from 'node:assert/strict'
import { test } from 'node:test'

import { GoogleCredentials, googlePolicyFromEnv } from './googleCredentials.js'

const policy = {
  serviceAccountEmail: 'runme@example.iam.gserviceaccount.com',
  allowedScopes: ['https://www.googleapis.com/auth/drive'],
}
const input = {
  expectedServiceAccountEmail: policy.serviceAccountEmail,
  scopes: policy.allowedScopes,
}

test('disabled provider and policy violations fail before network access', async () => {
  const request: typeof fetch = async () => {
    throw new Error('NETWORK SHOULD NOT RUN')
  }
  const provider = new GoogleCredentials(policy, request)
  await assert.rejects(
    new GoogleCredentials(undefined, request).mint(input),
    /disabled/
  )
  for (const bad of [
    {
      ...input,
      expectedServiceAccountEmail: 'other@example.iam.gserviceaccount.com',
    },
    { ...input, scopes: ['https://www.googleapis.com/auth/cloud-platform'] },
    { ...input, scopes: [] },
    { ...input, lifetimeSeconds: 3601 },
    { ...input, metadataUrl: 'http://attacker.test' },
  ])
    await assert.rejects(provider.mint(bad), /not allowed|Invalid/)
  assert.throws(() =>
    googlePolicyFromEnv({
      RUNME_GOOGLE_SERVICE_ACCOUNT: policy.serviceAccountEmail,
      RUNME_GOOGLE_SCOPES: 'https://www.googleapis.com/auth/cloud-platform',
    })
  )
})

test('direct metadata verifies identity, requests exact scopes, coalesces and refreshes using returned expiry', async () => {
  let now = Date.now()
  const calls: { url: URL; options: RequestInit }[] = []
  let sequence = 0
  const request: typeof fetch = async (url, options) => {
    const parsed = new URL(String(url))
    calls.push({ url: parsed, options: options! })
    assert.equal(parsed.origin, 'http://metadata.google.internal')
    if (parsed.pathname.endsWith('/email'))
      return new Response(policy.serviceAccountEmail + '\n')
    assert.equal(
      parsed.pathname,
      '/computeMetadata/v1/instance/service-accounts/default/token'
    )
    assert.equal(
      parsed.searchParams.get('scopes'),
      policy.allowedScopes.join(',')
    )
    assert.deepEqual([...parsed.searchParams.keys()], ['scopes'])
    return Response.json({
      access_token: `direct-${++sequence}`,
      token_type: 'Bearer',
      expires_in: 3600,
    })
  }
  const provider = new GoogleCredentials(policy, request, () => now)
  const [first, second] = await Promise.all([
    provider.mint(input),
    provider.mint(input),
  ])
  assert.equal(first.accessToken, 'direct-1')
  assert.deepEqual(first, second)
  first.scopes.push('mutated')
  assert.deepEqual((await provider.mint(input)).scopes, input.scopes)
  assert.equal(Date.parse(first.expiresAt), now + 3600000)
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.deepEqual(call.options.headers, { 'Metadata-Flavor': 'Google' })
    assert.equal(call.options.redirect, 'error')
  }
  now += 3479000
  assert.equal((await provider.mint(input)).accessToken, 'direct-1')
  assert.equal(calls.length, 2)
  now += 1000 // Two-minute refresh margin.
  assert.equal((await provider.mint(input)).accessToken, 'direct-2')
  assert.equal(calls.length, 4)
  assert.equal(
    (await provider.mint({ ...input, forceRefresh: true })).accessToken,
    'direct-3'
  )
  assert.equal(calls.length, 6)
})

test('metadata rejects obsolete mode, identity, scopes, endpoints, and caller-selected lifetime before fetching', async () => {
  const provider = new GoogleCredentials(policy, async () => {
    throw new Error('network must not run')
  })
  for (const bad of [
    { ...input, tokenMode: 'iam_exchange' as const },
    { ...input, tokenMode: undefined },
    {
      ...input,
      expectedServiceAccountEmail: 'other@example.iam.gserviceaccount.com',
    },
    {
      ...input,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    },
    {
      ...input,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    },
    { ...input, metadataUrl: 'http://attacker' },
    { ...input, lifetimeSeconds: 900 },
  ])
    await assert.rejects(provider.mint(bad), /not allowed|lifetimeSeconds/)
  assert.deepEqual(
    googlePolicyFromEnv({
      RUNME_GOOGLE_SERVICE_ACCOUNT: policy.serviceAccountEmail,
    }),
    policy
  )
  for (const mode of ['iam_exchange', 'metadata_direct', 'typo'])
    assert.throws(
      () =>
        googlePolicyFromEnv({
          RUNME_GOOGLE_SERVICE_ACCOUNT: policy.serviceAccountEmail,
          RUNME_GOOGLE_TOKEN_MODE: mode,
        }),
      /Remove RUNME_GOOGLE_TOKEN_MODE/
    )
})

test('direct metadata identity mismatch never requests a token or falls back to IAM', async () => {
  const calls: string[] = []
  const provider = new GoogleCredentials(policy, async (url) => {
    calls.push(String(url))
    return new Response('wrong@example.iam.gserviceaccount.com')
  })
  await assert.rejects(provider.mint(input), /metadata identity request failed/)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].endsWith('/email'))
})

test('direct metadata failures and malformed tokens are redacted, uncached, and never fall back', async () => {
  for (const failure of [
    'network',
    'forbidden',
    'json',
    'expired',
    'infinite',
    'string-expiry',
    'type',
    'missing-token',
  ]) {
    let failed = true
    let calls = 0
    const provider = new GoogleCredentials(policy, async (url) => {
      calls++
      assert.ok(String(url).startsWith('http://metadata.google.internal/'))
      if (String(url).endsWith('/email'))
        return new Response(policy.serviceAccountEmail)
      if (failed && failure === 'network') throw new Error('SECRET TOKEN')
      if (failed && failure === 'forbidden')
        return new Response('SECRET TOKEN', { status: 403 })
      if (failed && failure === 'json') return new Response('SECRET TOKEN')
      return Response.json({
        access_token:
          failed && failure === 'missing-token' ? '' : 'SECRET TOKEN',
        token_type: failed && failure === 'type' ? 'wrong' : 'Bearer',
        expires_in: !failed
          ? 3600
          : failure === 'expired'
            ? 0
            : failure === 'infinite'
              ? 1e300
              : failure === 'string-expiry'
                ? '3600'
                : 3600,
      })
    })
    await assert.rejects(
      provider.mint(input),
      (e: Error) =>
        /metadata token request failed/.test(e.message) &&
        !e.message.includes('SECRET')
    )
    assert.equal(calls, 2)
    failed = false
    assert.equal((await provider.mint(input)).accessToken, 'SECRET TOKEN')
    assert.equal(calls, 4)
  }
})

test('direct metadata retries transient responses without changing endpoint or identity', async () => {
  let attempts = 0
  const provider = new GoogleCredentials(policy, async (url) => {
    if (String(url).endsWith('/email'))
      return new Response(policy.serviceAccountEmail)
    assert.ok(String(url).includes('/token?scopes='))
    if (++attempts < 3) return new Response('', { status: 503 })
    return Response.json({
      access_token: 'scoped',
      token_type: 'Bearer',
      expires_in: 3600,
    })
  })
  assert.equal((await provider.mint(input)).accessToken, 'scoped')
  assert.equal(attempts, 3)
})
