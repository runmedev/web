/** Native Workspace files require export/conversion APIs, not raw notebook uploads. */
export function isNativeDriveFile(mimeType?: string): boolean {
  return Boolean(mimeType?.startsWith('application/vnd.google-apps.'))
}

/** A stable diagnostic also recognized after the error is persisted as text. */
export class UnsupportedDriveSyncError extends Error {
  constructor() {
    super(
      'RUNME_UNSUPPORTED_DRIVE_FILE: Native Google Workspace files cannot be synced as notebook bytes. Open the original in Drive or save a separate .runme copy. Local data is preserved.'
    )
  }
}

/**
 * Classify only known non-retryable failures. Read the structured reason from
 * the persisted Drive response too, so pre-upgrade failures do not requeue on
 * restart. Auth, quota, network, corrupt-local-data and unknown errors retain
 * their existing recovery behavior; an HTTP 400 alone is not sufficient.
 */
export function isPermanentDriveSyncError(error: unknown): boolean {
  return driveErrorChain(error).some(isPermanentDriveErrorMessage)
}

/** Retain nested Drive response diagnostics when creation wraps a rejected request. */
export function driveSyncErrorText(error: unknown): string {
  return driveErrorChain(error).map(String).join('\nCaused by: ')
}

/** Walk bounded, cycle-safe causes; persisted strings are already complete diagnostics. */
function driveErrorChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  while (error != null && !chain.includes(error) && chain.length < 10) {
    chain.push(error)
    error =
      typeof error === 'object' && 'cause' in error ? error.cause : undefined
  }
  return chain
}

/** Recognize only the explicit machine-readable rejection reason. */
function isPermanentDriveErrorMessage(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (
    message.startsWith('RUNME_UNSUPPORTED_DRIVE_FILE:') ||
    message.startsWith('Error: RUNME_UNSUPPORTED_DRIVE_FILE:')
  )
    return true
  if (!/Drive request failed \(400(?: |\))/.test(message)) return false
  const bodyStart = message.indexOf('{')
  if (bodyStart < 0) return false
  try {
    const body = JSON.parse(message.slice(bodyStart))
    return (
      body?.error?.errors?.some(
        (entry: { reason?: string }) =>
          entry?.reason === 'conversionUnsupportedConversionPath'
      ) === true
    )
  } catch {
    return false
  }
}
