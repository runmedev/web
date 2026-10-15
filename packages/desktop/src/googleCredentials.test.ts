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
  await provider.mint({ ...input, forceRefresh: true })
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
