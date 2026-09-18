import { describe, expect, it, vi } from 'vitest'

import { JSKernel } from './jsKernel'

function collectStdout(): {
  output: string[]
  onStdout: (data: string) => void
  onStderr: (data: string) => void
} {
  const output: string[] = []
  return {
    output,
    onStdout: (data: string) => output.push(data),
    onStderr: (data: string) => output.push(data),
  }
}

describe('JSKernel', () => {
  it('renders structured API rejections instead of [object Object]', async () => {
    const stderr = vi.fn()
    const kernel = new JSKernel({ hooks: { onStderr: stderr } })
    const result = await kernel.run(
      'throw { status: 404, result: { error: { message: "Notebook not found" } } };'
    )
    expect(result.exitCode).toBe(1)
    expect(stderr).toHaveBeenCalledWith(
      '{"status":404,"result":{"error":{"message":"Notebook not found"}}}\n'
    )
  })

  it('preserves Error and string diagnostics', async () => {
    const stderr = vi.fn()
    const kernel = new JSKernel({ hooks: { onStderr: stderr } })
    await kernel.run('throw new Error("Invalid notebook link");')
    expect(stderr).toHaveBeenLastCalledWith('Error: Invalid notebook link\n')
    await kernel.run('throw "Missing source";')
    expect(stderr).toHaveBeenLastCalledWith('Missing source\n')
    await kernel.run('throw undefined;')
    expect(stderr).toHaveBeenLastCalledWith('undefined\n')
  })

  it('does not serialize transport credentials or raw bodies into error outputs', async () => {
    const stderr = vi.fn()
    const kernel = new JSKernel({ hooks: { onStderr: stderr } })
    await kernel.run(
      `throw { status: 401, headers: { Authorization: 'secret-key' }, body: 'private notebook', result: { error: { message: 'Sign in again', access_token: 'secret-token' } } };`
    )
    expect(stderr).toHaveBeenCalledWith(
      '{"status":401,"result":{"error":{"message":"Sign in again"}}}\n'
    )
  })

  it('merges injected app helpers with built-in app helpers', async () => {
    const stdout = vi.fn()
    const kernel = new JSKernel({
      globals: {
        app: {
          ping: () => 'pong',
        },
      },
      hooks: {
        onStdout: stdout,
      },
    })

    await kernel.run('console.log(app.ping()); console.log(typeof app.clear);')

    expect(stdout).toHaveBeenCalledWith('pong\n')
    expect(stdout).toHaveBeenCalledWith('function\n')
  })

  it('merges per-run app helpers with constructor app helpers', async () => {
    const stdout = vi.fn()
    const kernel = new JSKernel({
      globals: {
        app: {
          baseOnly: () => 'base',
        },
      },
      hooks: {
        onStdout: stdout,
      },
    })

    await kernel.run(
      'console.log(app.baseOnly()); console.log(app.runOnly()); console.log(typeof app.render);',
      {
        globals: {
          app: {
            runOnly: () => 'run',
          },
        },
      }
    )

    expect(stdout).toHaveBeenCalledWith('base\n')
    expect(stdout).toHaveBeenCalledWith('run\n')
    expect(stdout).toHaveBeenCalledWith('function\n')
  })

  it('formats objects containing BigInt values for console output', async () => {
    const stdout = vi.fn()
    const kernel = new JSKernel({
      hooks: {
        onStdout: stdout,
      },
    })

    await kernel.run('console.log({ count: 1n, nested: { id: 2n } });')

    expect(stdout).toHaveBeenCalledWith('{"count":"1","nested":{"id":"2"}}\n')
  })

  it('supports console.table for arrays of objects', async () => {
    const stdout = vi.fn()
    const kernel = new JSKernel({
      hooks: {
        onStdout: stdout,
      },
    })

    await kernel.run(
      'console.table([{ id: "1", size: 10 }, { id: "2", modifiedTime: "today" }]);'
    )

    expect(stdout).toHaveBeenCalledWith(
      '(index)\tid\tsize\tmodifiedTime\n0\t1\t10\t\n1\t2\t\ttoday\n'
    )
  })
})

describe('JSKernel app globals', () => {
  it('preserves custom app namespaces like app.custom', async () => {
    const streams = collectStdout()
    const kernel = new JSKernel({
      globals: {
        app: {
          custom: {
            getDefault: () => 'default-custom',
          },
        },
      },
      hooks: streams,
    })

    await kernel.run('console.log(app.custom.getDefault())')

    expect(streams.output.join('')).toContain('default-custom')
  })

  it('preserves nested app namespaces like app.tools.registry', async () => {
    const streams = collectStdout()
    const kernel = new JSKernel({
      globals: {
        app: {
          tools: {
            registry: {
              getDefault: () => 'default-tool-registry',
            },
          },
        },
      },
      hooks: streams,
    })

    await kernel.run('console.log(app.tools.registry.getDefault())')

    expect(streams.output.join('')).toContain('default-tool-registry')
  })

  it('keeps app.runners helpers while preserving app.custom', async () => {
    const streams = collectStdout()
    const kernel = new JSKernel({
      globals: {
        app: {
          custom: {
            getDefault: () => 'default-custom',
          },
        },
        runmeRunners: {
          get: () => 'runner-list',
          update: () => 'updated',
          delete: () => 'deleted',
          getDefault: () => 'default-runner',
          setDefault: () => 'set-default',
        },
      },
      hooks: streams,
    })

    await kernel.run(`
      app.runners.get();
      console.log(app.custom.getDefault());
    `)

    const output = streams.output.join('')
    expect(output).toContain('runner-list')
    expect(output).toContain('default-custom')
  })

  it('retains existing app.runners when runmeRunners is not provided', async () => {
    const streams = collectStdout()
    const kernel = new JSKernel({
      globals: {
        app: {
          runners: {
            get: () => 'custom-runner-get',
          },
        },
      },
      hooks: streams,
    })

    await kernel.run('console.log(app.runners.get())')

    expect(streams.output.join('')).toContain('custom-runner-get')
  })
})
