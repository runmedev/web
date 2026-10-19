import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { assertLinuxBinary, getTarget } from '../scripts/target.js'

test('Linux packaging validates the target and runner ELF architecture', async () => {
  assert.deepEqual(
    getTarget({ RUNME_TARGET_PLATFORM: 'linux', RUNME_TARGET_ARCH: 'x64' }),
    { platform: 'linux', arch: 'x64' }
  )
  assert.throws(() => getTarget({ RUNME_TARGET_PLATFORM: 'typo' }))
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runme-elf-'))
  const file = path.join(directory, 'runme')
  try {
    const bytes = Buffer.alloc(64)
    bytes.write('7f454c46', 'hex')
    bytes[4] = 2
    bytes[5] = 1
    bytes.writeUInt16LE(62, 18)
    await writeFile(file, bytes)
    await assertLinuxBinary(file, 'x64')
    await assert.rejects(assertLinuxBinary(file, 'arm64'), /ELF/)
    await writeFile(file, 'macOS executable')
    await assert.rejects(assertLinuxBinary(file, 'x64'), /ELF/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
