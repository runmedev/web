import { expect, it } from 'vitest'

import { authorizeReleaseRequest } from './authorizeReleaseRequest'
import type { Control, Manifest } from './control'

const identity = { releaseId: 'selected', epoch: 2 }
const request = { tabId: 'unregistered', epoch: 2 }
function settings(): Control {
  return {
    format: 1,
    selection: { kind: 'channel', name: 'stable' },
    active: { manifest: { releaseId: 'selected' } as Manifest, epoch: 2 },
    tabs: {},
  }
}

it('accepts an unregistered tab without changing release state', () => {
  const state = settings()
  const before = structuredClone(state)
  expect(() => authorizeReleaseRequest(state, identity, request)).not.toThrow()
  expect(state).toEqual(before)
})

it('fences missing IDs and stale request or owner identities', () => {
  for (const client of [{ epoch: 2 }, { ...request, epoch: 1 }])
    expect(() =>
      authorizeReleaseRequest(settings(), identity, client)
    ).toThrow()
  for (const owner of [
    { ...identity, epoch: 1 },
    { ...identity, releaseId: 'old' },
  ])
    expect(() => authorizeReleaseRequest(settings(), owner, request)).toThrow()
  const missing = settings()
  delete missing.active
  expect(() => authorizeReleaseRequest(missing, identity, request)).toThrow()
})

it('retains handoff and legacy prepared-tab fences', () => {
  const state = settings()
  state.transition = {
    id: 'upgrade',
    epoch: 3,
    phase: 'prepare',
    target: { releaseId: 'next' } as Manifest,
    participants: {},
  }
  expect(() => authorizeReleaseRequest(state, identity, request)).not.toThrow()
  state.transition.participants.unregistered = { epoch: 2, ready: [] }
  expect(() => authorizeReleaseRequest(state, identity, request)).toThrow()
  state.transition.participants = {}
  state.transition.phase = 'handoff'
  expect(() => authorizeReleaseRequest(state, identity, request)).toThrow()
})
