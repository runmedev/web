// @vitest-environment jsdom
import { create } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../../runme/client'
import { appLogger } from '../logging/runtime'
import {
  createCodeModeExecutor,
  getCodeModeErrorOutput,
} from './codeModeExecutor'

const createNotebook = () => {
  const notebook = create(parser_pb.NotebookSchema, {
    cells: [],
  })
  return {
    getUri: () => 'local://test.runme.md',
    getName: () => 'test.runme.md',
    getNotebook: () => notebook,
    updateCell: () => {},
    getCell: () => null,
  }
}

describe('codeModeExecutor', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('merges stdout and stderr into one ordered output string', async () => {
    const infoSpy = vi.spyOn(appLogger, 'info')
    const notebook = createNotebook()
    const executor = createCodeModeExecutor({
      mode: 'browser',
      resolveNotebook: () => notebook,
      listNotebooks: () => [notebook],
    })

    const result = await executor.execute({
      source: 'chatkit',
      code: "console.log('one'); console.error('two'); console.log('three');",
    })

    expect(result.output).toContain('one')
    expect(result.output).toContain('two')
    expect(result.output).toContain('three')
    expect(result.output.indexOf('one')).toBeLessThan(
      result.output.indexOf('two')
    )
    expect(result.output.indexOf('two')).toBeLessThan(
      result.output.indexOf('three')
    )
    const started = infoSpy.mock.calls.find(
      ([message]) => message === 'Code mode execution started'
    )
    const completed = infoSpy.mock.calls.find(
      ([message]) => message === 'Code mode execution completed'
    )
    expect(started?.[1]?.attrs?.code).toContain("console.log('one')")
    expect(completed?.[1]?.attrs?.output).toContain('one')
    expect(completed?.[1]?.attrs?.output).toContain('two')
    expect(completed?.[1]?.attrs?.output).toContain('three')
    infoSpy.mockRestore()
  })

  it('truncates output when it exceeds the configured output budget', async () => {
    const notebook = createNotebook()
    const executor = createCodeModeExecutor({
      mode: 'browser',
      maxOutputBytes: 20,
      resolveNotebook: () => notebook,
      listNotebooks: () => [notebook],
    })

    const result = await executor.execute({
      source: 'chatkit',
      code: "console.log('abcdefghijklmnopqrstuvwxyz');",
    })

    expect(result.output).toContain('[output truncated]')
  })

  it('returns partial output when execution times out', async () => {
    const notebook = createNotebook()
    const executor = createCodeModeExecutor({
      mode: 'browser',
      timeoutMs: 20,
      resolveNotebook: () => notebook,
      listNotebooks: () => [notebook],
    })

    try {
      await executor.execute({
        source: 'codex',
        code: "console.log('started'); await new Promise(() => {});",
      })
      expect.fail('expected timeout error')
    } catch (error) {
      expect(String(error)).toMatch(/timed out/)
      expect(getCodeModeErrorOutput(error)).toContain('started')
    }
  })

  it('exposes opfs and net helpers in browser mode', async () => {
    const files = new Map<string, Uint8Array>()
    const directories = new Set<string>(['/'])

    const normalizePath = (path: string): string => {
      const segments = String(path ?? '')
        .split('/')
        .filter((segment) => segment.length > 0)
      return segments.length === 0 ? '/' : `/${segments.join('/')}`
    }

    const parentPath = (path: string): string => {
      const normalized = normalizePath(path)
      if (normalized === '/') {
        return '/'
      }
      const segments = normalized.split('/').filter(Boolean)
      return segments.length <= 1 ? '/' : `/${segments.slice(0, -1).join('/')}`
    }

    const makeDirectoryHandle = (path: string): FileSystemDirectoryHandle =>
      ({
        kind: 'directory',
        name:
          path === '/' ? '' : (path.split('/').filter(Boolean).at(-1) ?? ''),
        async getDirectoryHandle(name: string, options?: { create?: boolean }) {
          const childPath = normalizePath(`${path}/${name}`)
          if (!directories.has(childPath)) {
            if (!options?.create) {
              throw new DOMException('missing', 'NotFoundError')
            }
            directories.add(childPath)
          }
          return makeDirectoryHandle(childPath)
        },
        async getFileHandle(name: string, options?: { create?: boolean }) {
          const childPath = normalizePath(`${path}/${name}`)
          if (!files.has(childPath)) {
            if (!options?.create) {
              throw new DOMException('missing', 'NotFoundError')
            }
            directories.add(path)
            files.set(childPath, new Uint8Array())
          }
          return makeFileHandle(childPath)
        },
        async *entries() {
          const seen = new Set<string>()
          const prefix = path === '/' ? '/' : `${path}/`
          for (const directory of directories) {
            if (directory === path || !directory.startsWith(prefix)) {
              continue
            }
            const remainder = directory.slice(prefix.length)
            if (!remainder || remainder.includes('/')) {
              continue
            }
            if (seen.has(remainder)) {
              continue
            }
            seen.add(remainder)
            yield [remainder, makeDirectoryHandle(directory)] as const
          }
          for (const [filePath] of files) {
            if (!filePath.startsWith(prefix)) {
              continue
            }
            const remainder = filePath.slice(prefix.length)
            if (!remainder || remainder.includes('/')) {
              continue
            }
            if (seen.has(remainder)) {
              continue
            }
            seen.add(remainder)
            yield [remainder, makeFileHandle(filePath)] as const
          }
        },
        async removeEntry(name: string, options?: { recursive?: boolean }) {
          const childPath = normalizePath(`${path}/${name}`)
          if (files.delete(childPath)) {
            return
          }
          if (!directories.has(childPath)) {
            throw new DOMException('missing', 'NotFoundError')
          }
          const hasChildren =
            [...directories].some(
              (directory) =>
                directory !== childPath && directory.startsWith(`${childPath}/`)
            ) ||
            [...files.keys()].some((filePath) =>
              filePath.startsWith(`${childPath}/`)
            )
          if (hasChildren && options?.recursive !== true) {
            throw new DOMException('not empty', 'InvalidModificationError')
          }
          for (const directory of [...directories]) {
            if (
              directory === childPath ||
              directory.startsWith(`${childPath}/`)
            ) {
              directories.delete(directory)
            }
          }
          for (const filePath of [...files.keys()]) {
            if (
              filePath === childPath ||
              filePath.startsWith(`${childPath}/`)
            ) {
              files.delete(filePath)
            }
          }
        },
      }) as FileSystemDirectoryHandle

    const makeFileHandle = (path: string): FileSystemFileHandle =>
      ({
        kind: 'file',
        name: path.split('/').filter(Boolean).at(-1) ?? '',
        async getFile() {
          const bytes = files.get(path)
          if (!bytes) {
            throw new DOMException('missing', 'NotFoundError')
          }
          const blob = new Blob([bytes])
          return {
            size: bytes.byteLength,
            lastModified: 0,
            text: async () => new TextDecoder().decode(bytes),
            arrayBuffer: async () => blob.arrayBuffer(),
          } as File
        },
        async createWritable() {
          return {
            write: async (data: string | Uint8Array | Blob | ArrayBuffer) => {
              let next: Uint8Array
              if (typeof data === 'string') {
                next = new TextEncoder().encode(data)
              } else if (data instanceof Uint8Array) {
                next = data
              } else if (data instanceof ArrayBuffer) {
                next = new Uint8Array(data)
              } else {
                next = new Uint8Array(await data.arrayBuffer())
              }
              directories.add(parentPath(path))
              files.set(path, next)
            },
            close: async () => {},
          }
        },
      }) as FileSystemFileHandle

    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        getDirectory: vi.fn(async () => makeDirectoryHandle('/')),
      },
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('network-response', { status: 200 }))
    )

    const notebook = createNotebook()
    const executor = createCodeModeExecutor({
      mode: 'browser',
      resolveNotebook: () => notebook,
      listNotebooks: () => [notebook],
    })

    const result = await executor.execute({
      source: 'codex',
      code: [
        "await opfs.mkdir('/code/runmedev', { recursive: true });",
        "await opfs.writeText('/code/runmedev/web.txt', 'hello');",
        "console.log(await opfs.exists('/code/runmedev/web.txt'));",
        "console.log(await opfs.readText('/code/runmedev/web.txt'));",
        "console.log(JSON.stringify(await opfs.list('/code/runmedev')));",
        "const response = await net.get('https://example.test/docs');",
        'console.log(response.status);',
        'console.log(response.text);',
      ].join('\n'),
    })

    expect(result.output).toContain('true')
    expect(result.output).toContain('hello')
    expect(result.output).toContain('"name":"web.txt"')
    expect(result.output).toContain('200')
    expect(result.output).toContain('network-response')
  })
})
