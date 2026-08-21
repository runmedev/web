export type PanelKey =
  | 'explorer'
  | 'documentation'
  | 'authentication'
  | 'open-documents'
  | 'outline'
  | null

export type TourUiSnapshot = Readonly<{
  revision: number
  activePanel: PanelKey
  googleDriveAuthorized: boolean
  googleDriveFolderAddedCount: number
}>

export type TourUiWaitResult = TourUiSnapshot & {
  timedOut: boolean
}

export type TourUiWaitOptions = {
  afterRevision: number
  timeoutMs?: number
}

type Listener = () => void

const STORAGE_KEY = 'runme.sidePanel.active'
const LEGACY_STORAGE_KEY = 'aisre.sidePanel.active'
const DEFAULT_PANEL: PanelKey = 'explorer'
const MAX_WAIT_MS = 60_000

const PANEL_KEYS = new Set<PanelKey>([
  'explorer',
  'documentation',
  'authentication',
  'open-documents',
  'outline',
  null,
])

function readStoredPanel(): PanelKey {
  if (typeof window === 'undefined') return DEFAULT_PANEL
  try {
    const stored =
      window.localStorage.getItem(STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_STORAGE_KEY)
    if (stored === 'open-notebooks') return 'open-documents'
    if (stored !== null && PANEL_KEYS.has(stored as PanelKey)) {
      return stored as PanelKey
    }
  } catch (error) {
    console.error('Failed to read side panel state', error)
  }
  return DEFAULT_PANEL
}

function persistPanel(panel: PanelKey): void {
  if (typeof window === 'undefined') return
  try {
    if (panel) {
      window.localStorage.setItem(STORAGE_KEY, panel)
      window.localStorage.removeItem(LEGACY_STORAGE_KEY)
    } else {
      window.localStorage.removeItem(STORAGE_KEY)
      window.localStorage.removeItem(LEGACY_STORAGE_KEY)
    }
  } catch (error) {
    console.error('Failed to persist side panel state', error)
  }
}

function assertPanelKey(panel: unknown): asserts panel is PanelKey {
  if (!PANEL_KEYS.has(panel as PanelKey)) {
    throw new Error(
      'activePanel must be explorer, documentation, authentication, open-documents, outline, or null.'
    )
  }
}

function freezeSnapshot(snapshot: TourUiSnapshot): TourUiSnapshot {
  return Object.freeze(snapshot)
}

/**
 * Agent-facing model for UI state that must be observable and controllable
 * outside React. React subscribes to this controller with useSyncExternalStore.
 */
export class TourUiController {
  private snapshot: TourUiSnapshot = freezeSnapshot({
    revision: 0,
    activePanel: readStoredPanel(),
    googleDriveAuthorized: false,
    googleDriveFolderAddedCount: 0,
  })

  private readonly listeners = new Set<Listener>()

  readonly getSnapshot = (): TourUiSnapshot => this.snapshot

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly setActivePanel = (panel: PanelKey): TourUiSnapshot => {
    assertPanelKey(panel)
    persistPanel(panel)
    return this.update({ activePanel: panel })
  }

  readonly toggleActivePanel = (
    panel: Exclude<PanelKey, null>
  ): TourUiSnapshot => {
    assertPanelKey(panel)
    return this.setActivePanel(
      this.snapshot.activePanel === panel ? null : panel
    )
  }

  readonly setGoogleDriveAuthorized = (authorized: boolean): TourUiSnapshot =>
    this.update({ googleDriveAuthorized: Boolean(authorized) })

  readonly recordGoogleDriveFolderAdded = (): TourUiSnapshot =>
    this.update({
      googleDriveFolderAddedCount:
        this.snapshot.googleDriveFolderAddedCount + 1,
    })

  readonly waitForChange = async (
    options: TourUiWaitOptions
  ): Promise<TourUiWaitResult> => {
    const afterRevision = options.afterRevision
    if (!Number.isInteger(afterRevision) || afterRevision < 0) {
      throw new Error('afterRevision must be a non-negative integer.')
    }
    if (afterRevision > this.snapshot.revision) {
      throw new Error(
        `afterRevision ${afterRevision} is newer than the current revision ${this.snapshot.revision}.`
      )
    }
    if (this.snapshot.revision > afterRevision) {
      return { ...this.snapshot, timedOut: false }
    }

    const requestedTimeoutMs = options.timeoutMs ?? MAX_WAIT_MS
    if (!Number.isFinite(requestedTimeoutMs)) {
      throw new Error('timeoutMs must be a finite number.')
    }
    const timeoutMs = Math.min(
      MAX_WAIT_MS,
      Math.max(1, Math.trunc(requestedTimeoutMs))
    )
    return new Promise<TourUiWaitResult>((resolve) => {
      let settled = false
      const finish = (timedOut: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        unsubscribe()
        resolve({ ...this.snapshot, timedOut })
      }
      const unsubscribe = this.subscribe(() => finish(false))
      const timeoutId = setTimeout(() => finish(true), timeoutMs)
    })
  }

  /** Test-only reset for the singleton controller. */
  readonly resetForTests = (snapshot?: Partial<TourUiSnapshot>): void => {
    this.snapshot = freezeSnapshot({
      revision: 0,
      activePanel: DEFAULT_PANEL,
      googleDriveAuthorized: false,
      googleDriveFolderAddedCount: 0,
      ...snapshot,
    })
    for (const listener of this.listeners) listener()
  }

  private update(patch: Partial<TourUiSnapshot>): TourUiSnapshot {
    const changed = Object.entries(patch).some(
      ([key, value]) =>
        !Object.is(this.snapshot[key as keyof TourUiSnapshot], value)
    )
    if (!changed) return this.snapshot

    this.snapshot = freezeSnapshot({
      ...this.snapshot,
      ...patch,
      revision: this.snapshot.revision + 1,
    })
    for (const listener of this.listeners) listener()
    return this.snapshot
  }
}

export const tourUiController = new TourUiController()
