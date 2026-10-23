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
  private preparation?: AbortController
  private backupMessage = 'Editor backup has not been confirmed in this tab.'
  constructor(
    private readonly send: (message: RecoveryMessage) => void,
    private readonly reload: () => void,
    private readonly prepare = (signal: AbortSignal) =>
      storageRecovery.prepare(signal),
    private readonly backup = () => storageRecovery.backup()
  ) {}

  restart(): void {
    if (this.round) return
    this.round = crypto.randomUUID()
    storageRecovery.set({
      phase: 'preparing',
      message: 'Copying this tab’s editors before contacting storage…',
    })
    this.backupMessage = 'Editor backup has not been confirmed in this tab.'
    try {
      const count = this.backup()
      this.backupMessage = `${count} editor copies were saved in this tab’s session storage before requesting restart. Later edits are not included. Copies do not survive closing this tab.`
    } catch (error) {
      this.fail(
        `Could not back up this tab’s editors: ${String(error)}. Use Get recovery copies to download directly from the open editors before leaving this page.`
      )
      return
    }
    try {
      this.send(recoveryMessage('restart', this.round))
    } catch {
      this.fail(
        'The storage worker is disconnected. No automatic reload was performed. Download recovery copies before leaving this page.'
      )
      return
    }
    this.timer = setTimeout(() => {
      this.fail(
        'The storage worker did not acknowledge restart; it may be unresponsive or may not support coordinated restart. No automatic reload was performed. Other tabs have not confirmed backups. Download current recovery copies in every Runme tab before navigating away.'
      )
    }, 10_000)
  }

  async receive(message: RecoveryMessage): Promise<void> {
    if (message.protocol !== 1) return
    if (message.action === 'prepare') {
      if (this.preparingId === message.id) return
      clearTimeout(this.timer)
      if (this.release && this.round === message.id) {
        this.acknowledge(message.id)
        return
      }
      if (this.round !== message.id) {
        this.preparation?.abort()
        this.release?.()
        this.release = undefined
      }
      this.round = message.id
      this.preparingId = message.id
      this.timer = setTimeout(
        () =>
          this.fail(
            'Editor preparation timed out. No automatic reload was performed. Download current recovery copies before leaving this page.'
          ),
        30_000
      )
      const preparation = new AbortController()
      this.preparation = preparation
      storageRecovery.set({
        phase: 'preparing',
        message: 'Preserving editor contents in every connected Runme tab…',
      })
      try {
        const release = await this.prepare(preparation.signal)
        if (this.round !== message.id || this.preparation !== preparation) {
          release()
          return
        }
        clearTimeout(this.timer)
        this.backupMessage =
          'Editor copies were saved in this tab’s session storage during preparation. Copies do not survive closing this tab.'
        this.release = release
        this.acknowledge(message.id)
      } catch (error) {
        if (this.round === message.id && this.preparation === preparation)
          this.acknowledge(message.id, String(error))
      } finally {
        if (this.preparation === preparation) this.preparingId = undefined
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

  /** A broken message port must release editors instead of rejecting an unobserved receive promise. */
  private acknowledge(id: string, error?: string): void {
    try {
      this.send(recoveryMessage('ready', id, error))
    } catch {
      this.fail(
        'Storage disconnected while acknowledging editor copies. No automatic reload was performed.'
      )
    }
  }

  private fail(message: string): void {
    clearTimeout(this.timer)
    this.round = undefined
    this.preparation?.abort()
    this.preparation = undefined
    this.preparingId = undefined
    this.release?.()
    this.release = undefined
    storageRecovery.set({
      phase: 'blocked',
      message: `${message} ${this.backupMessage}`,
    })
  }

  /** Worker death must not leave editors frozen behind a preparation that cannot finish. */
  disconnected(): void {
    if (this.round)
      this.fail(
        'Storage disconnected during restart. No automatic reload was performed. Download current recovery copies before leaving this page.'
      )
  }
}
