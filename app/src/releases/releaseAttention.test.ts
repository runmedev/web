import { expect, it } from 'vitest'

import type { Control } from './control'
import { releaseAttention } from './releaseAttention'

it('distinguishes a downloaded update, an outdated tab, activation and a healthy pin', () => {
  const state = {
    active: { manifest: { releaseId: 'installed' } },
    selection: { kind: 'pinned', releaseId: 'installed' },
  } as Control
  expect(releaseAttention(state, 'installed')).toBeUndefined()
  state.candidate = { releaseId: 'new' } as Control['candidate']
  expect(releaseAttention(state, 'installed')?.kind).toBe('update')
  expect(releaseAttention(state, 'old')?.kind).toBe('reload')
  state.transition = { phase: 'handoff' } as Control['transition']
  expect(releaseAttention(state, 'old')?.kind).toBe('busy')
  state.ownerError = { message: 'Failed' } as Control['ownerError']
  expect(releaseAttention(state, 'old')?.kind).toBe('error')
})
