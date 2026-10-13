import { storageRecovery } from './storageRecovery'
import {
  type RecoveryMessage,
  recoveryMessage,
} from './storageRecoveryProtocol'

/** A tab only reloads after preserving its editors and receiving the owner's drained acknowledgement. */
export class StorageRecoveryClient {
  private round?: string
  private release?: () => void
  private timer?: ReturnType<typeof setTimeout>
  private preparingId?: string
  constructor(
    private readonly send: (message: RecoveryMessage) => void,
    private readonly reload: () => void,
    private readonly prepare = () => storageRecovery.prepare()
  ) {}

  restart(): void {
    if (this.round) return
    this.round = crypto.randomUUID()
    storageRecovery.set({
      phase: 'preparing',
      message: 'Asking all Runme tabs to preserve their edits…',
    })
    try {
      this.send(recoveryMessage('restart', this.round))
    } catch {
      this.fail(
        'The storage worker is disconnected. Preserve unsaved edits before reloading this tab.'
      )
      return
    }
    this.timer = setTimeout(() => {
      this.fail(
        'This worker does not support coordinated restart or is not responding. Preserve any unsaved edits, navigate all Runme tabs on this site away, then return. Closing the browser is unnecessary.'
      )
    }, 10_000)
  }

  async receive(message: RecoveryMessage): Promise<void> {
    if (message.protocol !== 1) return
    if (message.action === 'prepare') {
      clearTimeout(this.timer)
      if (this.preparingId === message.id) return
      if (this.release && this.round === message.id) {
        this.send(recoveryMessage('ready', message.id))
        return
      }
      if (this.round !== message.id) {
        this.release?.()
        this.release = undefined
      }
      this.round = message.id
      this.preparingId = message.id
      storageRecovery.set({
        phase: 'preparing',
        message: 'Preserving editor contents in every connected Runme tab…',
      })
      try {
        const release = await this.prepare()
        if (this.round !== message.id) {
          release()
          return
        }
        this.release = release
        this.send(recoveryMessage('ready', message.id))
      } catch (error) {
        if (this.round === message.id)
          this.send(recoveryMessage('ready', message.id, String(error)))
      } finally {
        if (this.preparingId === message.id) this.preparingId = undefined
      }
      return
    }
    if (message.id !== this.round) return
    if (message.action === 'blocked')
      this.fail(message.error ?? 'Storage restart could not complete.')
    if (message.action === 'draining')
      storageRecovery.set({
        phase: 'restarting',
        message:
          'Waiting for pending writes to finish before restarting Runme…',
      })
    if (message.action === 'reload') {
      clearTimeout(this.timer)
      if (!this.release) {
        this.fail('Notebook contents were not preserved. Reload was cancelled.')
        return
      }
      this.reload()
    }
  }

  private fail(message: string): void {
    clearTimeout(this.timer)
    this.round = undefined
    this.release?.()
    this.release = undefined
    storageRecovery.set({ phase: 'blocked', message })
  }

  /** Worker death must not leave editors frozen behind a preparation that cannot finish. */
  disconnected(): void {
    if (this.round)
      this.fail(
        'Storage disconnected during restart. Editor copies remain available; no automatic reload was performed.'
      )
  }
}
