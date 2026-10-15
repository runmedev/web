import { open } from 'node:fs/promises'

/** One target selection drives runner staging, Electron download, and artifact naming. */
export function getTarget(env: NodeJS.ProcessEnv = process.env) {
  const platform = env.RUNME_TARGET_PLATFORM ?? process.platform
  const arch = env.RUNME_TARGET_ARCH ?? process.arch
  if (
    !['linux', 'darwin', 'win32'].includes(platform) ||
    !['x64', 'arm64'].includes(arch)
  )
    throw new Error('Desktop target must be linux/darwin/win32 and x64/arm64')
  return {
    platform: platform as 'linux' | 'darwin' | 'win32',
    arch: arch as 'x64' | 'arm64',
  }
}

/** Reject host binaries accidentally included in a Linux distribution. */
export async function assertLinuxBinary(
  filename: string,
  arch: 'x64' | 'arm64'
) {
  const file = await open(filename, 'r')
  try {
    const header = Buffer.alloc(64)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    if (
      bytesRead < 64 ||
      header.toString('hex', 0, 4) !== '7f454c46' ||
      header[4] !== 2 ||
      header[5] !== 1 ||
      header.readUInt16LE(18) !== (arch === 'x64' ? 62 : 183)
    )
      throw new Error(`Expected a Linux ${arch} ELF executable: ${filename}`)
  } finally {
    await file.close()
  }
}
