import { afterEach, expect, it, vi } from 'vitest'

import { loaderController } from './loaderController'

/** Model browser lifecycle events without starting or replacing real workers. */
function workers(controller: ServiceWorker | null = null) {
  const events = new EventTarget()
  const update = vi.fn().mockResolvedValue(undefined)
  const registration = { update }
  const value = Object.assign(events, {
    controller,
    ready: new Promise<never>(() => {}),
    getRegistration: vi.fn().mockResolvedValue(registration),
    register: vi.fn().mockResolvedValue(registration),
  })
  return {
    value,
    container: value as unknown as ServiceWorkerContainer,
    update,
  }
}

const worker = { scriptURL: 'https://runme.test/sw.js' } as ServiceWorker

afterEach(() => vi.useRealTimers())

it('starts with the existing controller even when registration lookup and ready never settle', async () => {
  const { value, container } = workers(worker)
  value.getRegistration.mockReturnValue(new Promise(() => {}))
  await expect(loaderController(container)).resolves.toBe(worker)
  expect(value.register).not.toHaveBeenCalled()
})

it('keeps cached startup available when an update fails offline', async () => {
  const { container, update } = workers(worker)
  update.mockRejectedValue(new Error('offline'))
  await expect(loaderController(container)).resolves.toBe(worker)
  await Promise.resolve()
  expect(update).toHaveBeenCalledOnce()
})

it('observes a first installation claiming the page before registration resolves', async () => {
  const { value, container } = workers()
  value.getRegistration.mockResolvedValue(undefined)
  value.register.mockImplementation(() => {
    value.controller = worker
    value.dispatchEvent(new Event('controllerchange'))
    return new Promise(() => {})
  })
  await expect(loaderController(container)).resolves.toBe(worker)
  expect(value.register).toHaveBeenCalledWith('/sw.js', {
    updateViaCache: 'none',
  })
})

it('does not treat controllerchange without a controller as successful startup', async () => {
  vi.useFakeTimers()
  const { value, container } = workers()
  const remove = vi.spyOn(value, 'removeEventListener')
  const pending = loaderController(container, 1000)
  const failed = expect(pending).rejects.toThrow('Try a normal reload')
  value.dispatchEvent(new Event('controllerchange'))
  await vi.advanceTimersByTimeAsync(1000)
  await failed
  expect(remove).toHaveBeenCalledWith('controllerchange', expect.any(Function))
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds registration lookup that never completes', async () => {
  vi.useFakeTimers()
  const { value, container } = workers()
  value.getRegistration.mockReturnValue(new Promise(() => {}))
  const failed = expect(loaderController(container, 1000)).rejects.toThrow(
    'not controlling this tab'
  )
  await vi.advanceTimersByTimeAsync(1000)
  await failed
  expect(value.register).not.toHaveBeenCalled()
})

it('reports registration failure and removes its listener and deadline', async () => {
  vi.useFakeTimers()
  const { value, container } = workers()
  const remove = vi.spyOn(value, 'removeEventListener')
  value.getRegistration.mockResolvedValue(undefined)
  value.register.mockRejectedValue(new Error('Registration failed'))
  await expect(loaderController(container)).rejects.toThrow(
    'Registration failed'
  )
  expect(remove).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
