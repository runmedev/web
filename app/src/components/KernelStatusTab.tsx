import { Button, ScrollArea, Text, TextArea, TextField } from '@radix-ui/themes'
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'

import {
  DEFAULT_JUPYTER_KERNEL_ARGV,
  getJupyterManager,
} from '../lib/runtime/jupyterManager'

const defaultKernelArgv = JSON.stringify(DEFAULT_JUPYTER_KERNEL_ARGV)

function parseKernelArgv(value: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Kernel command must be a valid JSON array.')
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((argument) => typeof argument !== 'string')
  ) {
    throw new Error('Kernel command must be a non-empty JSON array of strings.')
  }
  const placeholderCount = parsed.reduce(
    (count, argument) =>
      count + argument.split('{connection_file}').length - 1,
    0
  )
  if (placeholderCount !== 1) {
    throw new Error(
      'Kernel command must contain exactly one {connection_file} placeholder.'
    )
  }
  return parsed
}

function formatLastActivity(value?: string): string {
  if (!value) {
    return '—'
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function stateClassName(state?: string): string {
  switch (state?.toLowerCase()) {
    case 'idle':
      return 'bg-emerald-50 text-emerald-700'
    case 'busy':
    case 'starting':
    case 'restarting':
      return 'bg-amber-50 text-amber-700'
    case 'dead':
      return 'bg-red-50 text-red-700'
    default:
      return 'bg-nb-surface-2 text-nb-text-muted'
  }
}

export function KernelStatusTab({ runnerName }: { runnerName: string }) {
  const manager = useMemo(() => getJupyterManager(), [])
  const version = useSyncExternalStore(
    useCallback((listener) => manager.subscribe(listener), [manager]),
    useCallback(() => manager.getVersion(), [manager]),
    useCallback(() => manager.getVersion(), [manager])
  )
  const kernels = useMemo(
    () => manager.getKernelsForRunner(runnerName),
    [manager, runnerName, version]
  )
  const [kernelSpec, setKernelSpec] = useState('python3')
  const [kernelArgv, setKernelArgv] = useState(defaultKernelArgv)
  const [alias, setAlias] = useState('')
  const [loading, setLoading] = useState(true)
  const [operation, setOperation] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setErrorMessage('')
    try {
      await manager.listKernels(runnerName)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [manager, runnerName])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const startKernel = useCallback(async () => {
    const requestedKernelSpec = kernelSpec.trim()
    if (!requestedKernelSpec) {
      setErrorMessage('Kernel spec is required.')
      return
    }
    let requestedArgv: string[]
    try {
      requestedArgv = parseKernelArgv(kernelArgv)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
      return
    }
    setOperation('start')
    setErrorMessage('')
    try {
      await manager.startKernel(runnerName, {
        kernelSpec: requestedKernelSpec,
        argv: requestedArgv,
        ...(alias.trim() ? { name: alias.trim() } : {}),
      })
      setAlias('')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setOperation(null)
    }
  }, [alias, kernelArgv, kernelSpec, manager, runnerName])

  const restartKernel = useCallback(
    async (kernelID: string) => {
      setOperation(`restart:${kernelID}`)
      setErrorMessage('')
      try {
        await manager.restartKernel(runnerName, kernelID)
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error))
      } finally {
        setOperation(null)
      }
    },
    [manager, runnerName]
  )

  const stopKernel = useCallback(
    async (kernelID: string) => {
      setOperation(`stop:${kernelID}`)
      setErrorMessage('')
      try {
        await manager.stopKernel(runnerName, kernelID)
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error))
      } finally {
        setOperation(null)
      }
    },
    [manager, runnerName]
  )

  return (
    <ScrollArea
      type="auto"
      scrollbars="vertical"
      className="flex-1 p-4"
      data-testid="kernel-status-scroll"
    >
      <div className="mx-auto flex h-full max-w-6xl flex-col gap-6 text-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <Text size="5" weight="bold" as="p" className="text-nb-text">
              Jupyter Kernels
            </Text>
            <Text size="2" as="p" className="text-nb-text-muted">
              Manage kernels owned by runner{' '}
              <span className="font-mono font-semibold">{runnerName}</span>.
            </Text>
          </div>
          <Button
            variant="soft"
            disabled={loading || operation !== null}
            onClick={() => void refresh()}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>

        <div className="rounded-lg border border-nb-border bg-white p-4">
          <Text size="3" weight="bold" as="p" className="text-nb-text">
            Start a kernel
          </Text>
          <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(180px,1fr)_minmax(180px,1fr)_auto] sm:items-end">
            <label className="space-y-1 sm:col-span-3">
              <Text
                size="1"
                as="p"
                className="font-semibold text-nb-text-muted"
              >
                Kernel command (JSON argv)
              </Text>
              <TextArea
                aria-label="Kernel command"
                value={kernelArgv}
                disabled={operation !== null}
                onChange={(event) => setKernelArgv(event.target.value)}
                resize="vertical"
              />
              <Text size="1" as="p" className="text-nb-text-faint">
                Paths are resolved on the runner host. Include exactly one{' '}
                <span className="font-mono">{'{connection_file}'}</span>{' '}
                placeholder.
              </Text>
            </label>
            <label className="space-y-1">
              <Text
                size="1"
                as="p"
                className="font-semibold text-nb-text-muted"
              >
                Kernel spec
              </Text>
              <TextField.Root
                aria-label="Kernel spec"
                value={kernelSpec}
                disabled={operation !== null}
                onChange={(event) => setKernelSpec(event.target.value)}
                placeholder="python3"
              />
            </label>
            <label className="space-y-1">
              <Text
                size="1"
                as="p"
                className="font-semibold text-nb-text-muted"
              >
                Display name (optional)
              </Text>
              <TextField.Root
                aria-label="Display name"
                value={alias}
                disabled={operation !== null}
                onChange={(event) => setAlias(event.target.value)}
                placeholder="analysis"
              />
            </label>
            <Button
              disabled={operation !== null || !kernelSpec.trim()}
              onClick={() => void startKernel()}
            >
              {operation === 'start' ? 'Starting…' : 'Start kernel'}
            </Button>
          </div>
        </div>

        {errorMessage && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            {errorMessage}
          </div>
        )}

        <div className="rounded-lg border border-nb-border bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Text size="3" weight="bold" as="p" className="text-nb-text">
              Running kernels
            </Text>
            <span className="rounded-full bg-nb-surface-2 px-2.5 py-1 text-xs font-semibold text-nb-text-muted">
              {kernels.length} {kernels.length === 1 ? 'kernel' : 'kernels'}
            </span>
          </div>

          {!loading && kernels.length === 0 ? (
            <Text size="2" as="p" className="mt-4 text-nb-text-muted">
              No kernels are running on this runner.
            </Text>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-nb-border bg-nb-surface-2 text-xs font-semibold uppercase tracking-wide text-nb-text-muted">
                    <th className="whitespace-nowrap px-3 py-2">Name</th>
                    <th className="whitespace-nowrap px-3 py-2">Kernel ID</th>
                    <th className="whitespace-nowrap px-3 py-2">State</th>
                    <th className="whitespace-nowrap px-3 py-2">Connections</th>
                    <th className="whitespace-nowrap px-3 py-2">
                      Last activity
                    </th>
                    <th className="whitespace-nowrap px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {kernels.map((kernel) => {
                    const restarting = operation === `restart:${kernel.id}`
                    const stopping = operation === `stop:${kernel.id}`
                    return (
                      <tr
                        key={kernel.id}
                        className="border-b border-nb-border last:border-0"
                      >
                        <td className="px-3 py-3 font-medium text-nb-text">
                          {kernel.label}
                          {kernel.label !== kernel.name && (
                            <div className="mt-1 text-xs font-normal text-nb-text-faint">
                              {kernel.name}
                            </div>
                          )}
                        </td>
                        <td className="max-w-[280px] break-all px-3 py-3 font-mono text-xs text-nb-text-muted">
                          {kernel.id}
                        </td>
                        <td className="px-3 py-3">
                          <span
                            className={`rounded-full px-2 py-1 text-xs font-semibold ${stateClassName(kernel.execution_state)}`}
                          >
                            {kernel.execution_state || 'unknown'}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-nb-text-muted">
                          {kernel.connections ?? 0}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-nb-text-muted">
                          {formatLastActivity(kernel.last_activity)}
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="1"
                              variant="soft"
                              disabled={operation !== null}
                              onClick={() => void restartKernel(kernel.id)}
                            >
                              {restarting ? 'Restarting…' : 'Restart'}
                            </Button>
                            <Button
                              size="1"
                              variant="soft"
                              color="red"
                              disabled={operation !== null}
                              onClick={() => void stopKernel(kernel.id)}
                            >
                              {stopping ? 'Stopping…' : 'Stop'}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </ScrollArea>
  )
}

export default KernelStatusTab
