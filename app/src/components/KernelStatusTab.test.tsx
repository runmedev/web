// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const createSessionId = vi.hoisted(() => vi.fn())

type Kernel = {
  id: string
  name: string
  label: string
  execution_state?: string
  connections?: number
  last_activity?: string
}

let kernels: Kernel[] = []
let version = 0
const listeners = new Set<() => void>()

function bumpVersion() {
  version += 1
  listeners.forEach((listener) => listener())
}

const listKernels = vi.fn(async () => {
  bumpVersion()
  return kernels
})
const startKernel = vi.fn(
  async (
    _runnerName: string,
    options: { kernelSpec?: string; name?: string; argv?: string[] }
  ) => {
    const kernel = {
      id: 'kernel-2',
      name: options.kernelSpec || 'python3',
      label: options.name || options.kernelSpec || 'python3',
      execution_state: 'starting',
      connections: 0,
    }
    kernels = [...kernels, kernel]
    bumpVersion()
    return kernel
  }
)
const restartKernel = vi.fn(async (_runnerName: string, kernelID: string) => {
  kernels = kernels.map((kernel) =>
    kernel.id === kernelID
      ? { ...kernel, execution_state: 'restarting' }
      : kernel
  )
  bumpVersion()
  return kernels.find((kernel) => kernel.id === kernelID)
})
const stopKernel = vi.fn(async (_runnerName: string, kernelID: string) => {
  kernels = kernels.filter((kernel) => kernel.id !== kernelID)
  bumpVersion()
})

vi.mock('../lib/runtime/jupyterManager', () => ({
  DEFAULT_JUPYTER_KERNEL_ARGV: [
    'python3',
    '-m',
    'ipykernel_launcher',
    '-f',
    '{connection_file}',
  ],
  getJupyterManager: () => ({
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getVersion: () => version,
    getKernelsForRunner: () => kernels,
    listKernels,
    startKernel,
    restartKernel,
    stopKernel,
  }),
}))

vi.mock('../lib/tabIdentity', () => ({ createSessionId }))

import { KernelStatusTab } from './KernelStatusTab'

describe('KernelStatusTab', () => {
  beforeEach(() => {
    kernels = [
      {
        id: 'kernel-1',
        name: 'python3',
        label: 'analysis',
        execution_state: 'idle',
        connections: 2,
        last_activity: '2026-08-05T10:00:00Z',
      },
    ]
    version = 0
    listeners.clear()
    listKernels.mockClear()
    startKernel.mockClear()
    restartKernel.mockClear()
    stopKernel.mockClear()
    createSessionId
      .mockReset()
      .mockReturnValueOnce('silver-wind')
      .mockReturnValueOnce('wise-beacon')
  })

  it('loads and displays runner-owned kernels', async () => {
    const { container } = render(<KernelStatusTab runnerName="default" />)

    await waitFor(() => expect(listKernels).toHaveBeenCalledWith('default'))
    expect(container.querySelector('#kernel-status-tab')).toBeTruthy()
    expect(container.querySelector('#kernel-start-panel')).toBeTruthy()
    expect(container.querySelector('#kernel-list-panel')).toBeTruthy()
    expect(container.querySelector('#kernel-actions-kernel-1')).toBeTruthy()
    expect(screen.getByText('Jupyter Kernels')).toBeTruthy()
    expect(screen.getByText('analysis')).toBeTruthy()
    expect(screen.getByText('kernel-1')).toBeTruthy()
    expect(screen.getByText('idle')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
  })

  it('starts, restarts, and stops kernels', async () => {
    render(<KernelStatusTab runnerName="default" />)
    await waitFor(() => expect(listKernels).toHaveBeenCalled())

    fireEvent.change(screen.getByRole('textbox', { name: 'Kernel spec' }), {
      target: { value: 'python-custom' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Kernel command' }), {
      target: {
        value:
          '["/workspace/.venv/bin/python","-m","ipykernel_launcher","-f","{connection_file}"]',
      },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), {
      target: { value: 'training' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start kernel' }))

    await waitFor(() =>
      expect(startKernel).toHaveBeenCalledWith('default', {
        kernelSpec: 'python-custom',
        name: 'training',
        argv: [
          '/workspace/.venv/bin/python',
          '-m',
          'ipykernel_launcher',
          '-f',
          '{connection_file}',
        ],
      })
    )
    expect(await screen.findByText('training')).toBeTruthy()

    const restartButtons = screen.getAllByRole('button', { name: 'Restart' })
    fireEvent.click(restartButtons[0])
    await waitFor(() =>
      expect(restartKernel).toHaveBeenCalledWith('default', 'kernel-1')
    )

    const stopButtons = screen.getAllByRole('button', { name: 'Stop' })
    fireEvent.click(stopButtons[0])
    await waitFor(() =>
      expect(stopKernel).toHaveBeenCalledWith('default', 'kernel-1')
    )
    await waitFor(() => expect(screen.queryByText('kernel-1')).toBeNull())
  })

  it('provides a fresh memorable display name after starting a kernel', async () => {
    render(<KernelStatusTab runnerName="default" />)
    await waitFor(() => expect(listKernels).toHaveBeenCalled())

    const displayName = screen.getByRole('textbox', { name: 'Display name' })
    expect((displayName as HTMLInputElement).value).toBe('silver-wind')

    fireEvent.click(screen.getByRole('button', { name: 'Start kernel' }))

    await waitFor(() =>
      expect(startKernel).toHaveBeenCalledWith('default', {
        kernelSpec: 'python3',
        name: 'silver-wind',
        argv: [
          'python3',
          '-m',
          'ipykernel_launcher',
          '-f',
          '{connection_file}',
        ],
      })
    )
    await waitFor(() =>
      expect((displayName as HTMLInputElement).value).toBe('wise-beacon')
    )
  })
})
