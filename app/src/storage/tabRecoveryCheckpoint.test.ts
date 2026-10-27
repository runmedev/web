import { afterEach, expect, it, vi } from 'vitest'

import { createInitialNotebookFile } from '../lib/notebookFormat'
import { EditorSaveSession } from './editorSaveSession'
import {
  acknowledgeTabCheckpoint,
  readTabCheckpoints,
  writeTabCheckpoints,
} from './tabRecoveryCheckpoint'

afterEach(() => {
  vi.restoreAllMocks()
  sessionStorage.clear()
})

it('retains every checkpoint until its own restored save is acknowledged', async () => {
  const a = await new EditorSaveSession(
    'a',
    createInitialNotebookFile('a.runme'),
    async () => {}
  ).checkpoint()
  const b = await new EditorSaveSession(
    'b',
    createInitialNotebookFile('b.runme'),
    async () => {}
  ).checkpoint()
  writeTabCheckpoints([a])
  writeTabCheckpoints([b])
  expect(readTabCheckpoints()).toEqual([a, b])
  acknowledgeTabCheckpoint('a', 'wrong-actor')
  expect(readTabCheckpoints()).toHaveLength(2)
  acknowledgeTabCheckpoint('a', a.actorId)
  expect(readTabCheckpoints()).toEqual([b])
})

it('rejects quota failure and failed write verification instead of authorizing reload', async () => {
  const entry = await new EditorSaveSession(
    'a',
    createInitialNotebookFile('a.runme'),
    async () => {}
  ).checkpoint()
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Full', 'QuotaExceededError')
  })
  expect(() => writeTabCheckpoints([entry])).toThrow('Full')
  vi.restoreAllMocks()
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {})
  expect(() => writeTabCheckpoints([entry])).toThrow('could not be verified')
})

it('retains unsupported recovery bytes', () => {
  const raw = '{"format":99,"editors":[]}'
  sessionStorage.setItem('runme/tab-editor-recovery/v1', raw)
  expect(readTabCheckpoints).toThrow('Unsupported')
  expect(sessionStorage.getItem('runme/tab-editor-recovery/v1')).toBe(raw)
})
