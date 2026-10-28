/** Recovery deliberately remains independent of the versioned notebook RPC protocol. */
export const STORAGE_RECOVERY_PROTOCOL = 1
export type RecoveryMessage = {
  type: 'storage-recovery'
  protocol: 1
  action:
    | 'register'
    | 'restart'
    | 'prepare'
    | 'ready'
    | 'blocked'
    | 'draining'
    | 'reload'
  id: string
  error?: string
}
export const recoveryMessage = (
  action: RecoveryMessage['action'],
  id: string,
  error?: string
): RecoveryMessage => ({
  type: 'storage-recovery',
  protocol: STORAGE_RECOVERY_PROTOCOL,
  action,
  id,
  error,
})
