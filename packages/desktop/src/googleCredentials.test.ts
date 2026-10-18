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
  lifetimeSeconds: 900,
}

test('metadata -> IAM exchange is pinned, coalesced, refreshed, and never returns the source token', async () => {
  let now = Date.now()
  const calls: { url: string; options: RequestInit }[] = []
  const request: typeof fetch = async (url, options) => {
    calls.push({ url: String(url), options: options! })
    if (String(url).startsWith('http://metadata.google.internal/'))
      return Response.json({
        access_token: 'source-only',
        token_type: 'Bearer',
        expires_in: 3600,
      })
    return Response.json({
      accessToken: 'scoped',
      expireTime: new Date(now + 900000).toISOString(),
    })
  }
  const provider = new GoogleCredentials(policy, request, () => now)
  const results = await Promise.all([
    provider.mint(input),
    provider.mint(input),
  ])
  assert.equal(calls.length, 2)
  assert.equal(
    calls[0].url,
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'
  )
  assert.deepEqual(calls[0].options.headers, { 'Metadata-Flavor': 'Google' })
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(
    calls[1].url,
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${policy.serviceAccountEmail}:generateAccessToken`
  )
  assert.deepEqual(JSON.parse(calls[1].options.body as string), {
    scope: input.scopes,
    lifetime: '900s',
  })
  assert.equal(results[0].accessToken, 'scoped')
  assert.ok(!JSON.stringify(results).includes('source-only'))
  results[0].scopes.push('mutated')
  assert.deepEqual((await provider.mint(input)).scopes, input.scopes)
  assert.equal(calls.length, 2)
  await provider.mint({
    ...input,
    tokenMode: 'iam_exchange',
    forceRefresh: true,
  })
  assert.equal(calls.length, 4)
  now += 800000
  await provider.mint(input)
  assert.equal(calls.length, 6)
})

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

test('malformed expiry and upstream exceptions are redacted and failures can be retried', async () => {
  let fail = true
  const provider = new GoogleCredentials(policy, async (url) => {
    if (String(url).startsWith('http:'))
      return Response.json({
        access_token: 'sensitive',
        token_type: 'Bearer',
        expires_in: 3600,
      })
    if (fail) throw new Error('sensitive response body')
    return Response.json({ accessToken: 'secret', expireTime: 'invalid' })
  })
  await assert.rejects(
    provider.mint(input),
    (error: Error) =>
      /IAM Credentials/.test(error.message) && !/sensitive/.test(error.message)
  )
  fail = false
  await assert.rejects(provider.mint(input), /IAM Credentials request failed/)
})

const directPolicy = { ...policy, tokenMode: 'metadata_direct' as const }
const directInput = {
  expectedServiceAccountEmail: policy.serviceAccountEmail,
  scopes: policy.allowedScopes,
  tokenMode: 'metadata_direct' as const,
}

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
  const provider = new GoogleCredentials(directPolicy, request, () => now)
  const [first, second] = await Promise.all([
    provider.mint(directInput),
    provider.mint(directInput),
  ])
  assert.equal(first.accessToken, 'direct-1')
  assert.deepEqual(first, second)
  assert.equal(Date.parse(first.expiresAt), now + 3600000)
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.deepEqual(call.options.headers, { 'Metadata-Flavor': 'Google' })
    assert.equal(call.options.redirect, 'error')
  }
  now += 3479000
  assert.equal((await provider.mint(directInput)).accessToken, 'direct-1')
  assert.equal(calls.length, 2)
  now += 1000 // Two-minute refresh margin.
  assert.equal((await provider.mint(directInput)).accessToken, 'direct-2')
  assert.equal(calls.length, 4)
  assert.equal(
    (await provider.mint({ ...directInput, forceRefresh: true })).accessToken,
    'direct-3'
  )
  assert.equal(calls.length, 6)
})

test('direct metadata rejects host mode, identity, scopes, endpoints, and caller-selected lifetime before fetching', async () => {
  const provider = new GoogleCredentials(directPolicy, async () => {
    throw new Error('network must not run')
  })
  for (const bad of [
    { ...directInput, tokenMode: 'iam_exchange' as const },
    { ...directInput, tokenMode: undefined },
    {
      ...directInput,
      expectedServiceAccountEmail: 'other@example.iam.gserviceaccount.com',
    },
    {
      ...directInput,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    },
    {
      ...directInput,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    },
    { ...directInput, metadataUrl: 'http://attacker' },
    { ...directInput, lifetimeSeconds: 900 },
  ])
    await assert.rejects(provider.mint(bad), /not allowed|lifetimeSeconds/)
  await assert.rejects(
    new GoogleCredentials(policy).mint(directInput),
    /not allowed/
  )
  assert.equal(
    googlePolicyFromEnv({
      RUNME_GOOGLE_SERVICE_ACCOUNT: policy.serviceAccountEmail,
    })?.tokenMode,
    'iam_exchange'
  )
  assert.equal(
    googlePolicyFromEnv({
      RUNME_GOOGLE_SERVICE_ACCOUNT: policy.serviceAccountEmail,
      RUNME_GOOGLE_TOKEN_MODE: 'metadata_direct',
    })?.tokenMode,
    'metadata_direct'
  )
  assert.throws(
    () =>
      googlePolicyFromEnv({
        RUNME_GOOGLE_SERVICE_ACCOUNT: policy.serviceAccountEmail,
        RUNME_GOOGLE_TOKEN_MODE: 'typo',
      }),
    /Invalid/
  )
})

test('direct metadata identity mismatch never requests a token or falls back to IAM', async () => {
  const calls: string[] = []
  const provider = new GoogleCredentials(directPolicy, async (url) => {
    calls.push(String(url))
    return new Response('wrong@example.iam.gserviceaccount.com')
  })
  await assert.rejects(
    provider.mint(directInput),
    /metadata identity request failed/
  )
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
    const provider = new GoogleCredentials(directPolicy, async (url) => {
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
      provider.mint(directInput),
      (e: Error) =>
        /metadata token request failed/.test(e.message) &&
        !e.message.includes('SECRET')
    )
    assert.equal(calls, 2)
    failed = false
    assert.equal((await provider.mint(directInput)).accessToken, 'SECRET TOKEN')
    assert.equal(calls, 4)
  }
})

test('direct metadata retries transient responses without changing endpoint or identity', async () => {
  let attempts = 0
  const provider = new GoogleCredentials(directPolicy, async (url) => {
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
  assert.equal((await provider.mint(directInput)).accessToken, 'scoped')
  assert.equal(attempts, 3)
})
