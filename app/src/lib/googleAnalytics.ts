export type NotebookAnalyticsSource =
  | 'local'
  | 'google_drive'
  | 'http'
  | 'unknown'

export type NotebookAccessMode = 'read_write' | 'read_only'

export type ExecutionBackend = 'appkernel' | 'jupyter' | 'runner'

type Gtag = (...args: unknown[]) => void

type AnalyticsGlobal = {
  dataLayer?: Array<ArrayLike<unknown>>
  gtag?: Gtag
}

export interface GoogleAnalyticsClientOptions {
  measurementId?: string
  hostname: string
  doNotTrack?: string | null
  globalPrivacyControl?: boolean
  document: Pick<Document, 'createElement' | 'getElementById' | 'head'>
  globalObject: AnalyticsGlobal
}

const GOOGLE_ANALYTICS_HOSTNAME = 'web.runme.dev'
const GOOGLE_ANALYTICS_SCRIPT_ID = 'runme-google-analytics'
const SAFE_PAGE_LOCATION = 'https://web.runme.dev/'
const SAFE_PAGE_TITLE = 'Runme Web'
const SAFE_PAGE_CONTEXT = {
  page_location: SAFE_PAGE_LOCATION,
  page_referrer: '',
  page_title: SAFE_PAGE_TITLE,
} as const

function isValidMeasurementId(value: string | undefined): value is string {
  return typeof value === 'string' && /^G-[A-Z0-9]+$/.test(value)
}

export function classifyNotebookAnalyticsSource(
  requestedUri: string
): NotebookAnalyticsSource {
  try {
    const url = new URL(requestedUri)
    if (url.protocol === 'local:' || url.protocol === 'fs:') {
      return 'local'
    }
    if (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.hostname === 'drive.google.com'
    ) {
      return 'google_drive'
    }
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      return 'http'
    }
  } catch {
    // Unknown and malformed values intentionally collapse to one safe enum.
  }
  return 'unknown'
}

export class GoogleAnalyticsClient {
  private gtag: Gtag | undefined

  constructor(private readonly options: GoogleAnalyticsClientOptions) {}

  initialize(): boolean {
    if (this.gtag) {
      return true
    }

    const {
      document,
      doNotTrack,
      globalObject,
      globalPrivacyControl,
      hostname,
      measurementId,
    } = this.options
    if (
      !isValidMeasurementId(measurementId) ||
      hostname !== GOOGLE_ANALYTICS_HOSTNAME ||
      doNotTrack === '1' ||
      globalPrivacyControl === true
    ) {
      return false
    }

    try {
      const dataLayer = (globalObject.dataLayer ??= [])
      const gtag =
        globalObject.gtag ??
        function (this: unknown) {
          dataLayer.push(arguments)
        }
      globalObject.gtag = gtag

      if (!document.getElementById(GOOGLE_ANALYTICS_SCRIPT_ID)) {
        const script = document.createElement('script')
        script.id = GOOGLE_ANALYTICS_SCRIPT_ID
        script.async = true
        script.referrerPolicy = 'no-referrer'
        script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(
          measurementId
        )}`
        document.head.append(script)
      }

      gtag('js', new Date())
      gtag('config', measurementId, {
        allow_ad_personalization_signals: false,
        allow_google_signals: false,
        send_page_view: false,
        ...SAFE_PAGE_CONTEXT,
      })
      this.gtag = gtag
      return true
    } catch {
      this.gtag = undefined
      return false
    }
  }

  trackNotebookOpened(params: {
    notebookSource: NotebookAnalyticsSource
    accessMode: NotebookAccessMode
  }): void {
    this.sendEvent('notebook_opened', {
      access_mode: params.accessMode,
      notebook_source: params.notebookSource,
    })
  }

  trackCellExecuted(params: { executionBackend: ExecutionBackend }): void {
    this.sendEvent('cell_executed', {
      execution_backend: params.executionBackend,
    })
  }

  private sendEvent(
    eventName: 'notebook_opened' | 'cell_executed',
    params: Record<string, string>
  ): void {
    try {
      this.gtag?.('event', eventName, {
        ...params,
        ...SAFE_PAGE_CONTEXT,
      })
    } catch {
      // Analytics must never affect notebook loading or execution.
    }
  }
}

const navigatorWithPrivacySignals = navigator as Navigator & {
  globalPrivacyControl?: boolean
}

export const googleAnalytics = new GoogleAnalyticsClient({
  measurementId: import.meta.env.VITE_GOOGLE_ANALYTICS_MEASUREMENT_ID,
  hostname: window.location.hostname,
  doNotTrack: navigator.doNotTrack,
  globalPrivacyControl: navigatorWithPrivacySignals.globalPrivacyControl,
  document,
  globalObject: window as AnalyticsGlobal,
})
