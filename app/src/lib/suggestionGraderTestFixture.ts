import { webcrypto } from 'node:crypto'
import { onTestFinished, vi } from 'vitest'

import type LocalNotebooks from '../storage/local'
import { keyVault } from './keyvault/store'
import { appState } from './runtime/AppState'

/** Exercise the shared grading transport with a mounted rubric and unlocked test key. */
export function mockGraderSources() {
  if (!crypto.subtle) vi.stubGlobal('crypto', webcrypto)
  vi.spyOn(keyVault, 'getSnapshot').mockReturnValue({
    status: 'unlocked',
    names: ['review'],
  })
  vi.spyOn(keyVault, 'requireValue').mockReturnValue('test-key')
  const read = vi.fn().mockResolvedValue('Accept clear prose.')
  vi.spyOn(appState, 'getWorkspaceItems').mockReturnValue([
    'local://file/rules',
  ])
  const previous = appState.localNotebooks
  appState.setLocalNotebooks({
    readGradingInstructions: read,
    listMountedRubrics: async () => ({rows:[{uri:'local://file/rules', name:'rules.runme', folder:'Editorial'}]}),
    subscribeSync: () => () => {},
  } as unknown as LocalNotebooks)
  onTestFinished(() => appState.setLocalNotebooks(previous))
  return read
}
