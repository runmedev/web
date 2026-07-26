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

type AnalyticsPageContext = {
  page_location: string
  page_referrer: ''
  page_title: 'Runme Web'
}

export interface GoogleAnalyticsClientOptions {
  measurementId?: string
  hostname: string
  origin: string
  doNotTrack?: string | null
  globalPrivacyControl?: boolean
  document: Pick<Document, 'createElement' | 'getElementById' | 'head'>
  globalObject: AnalyticsGlobal
}

const GOOGLE_ANALYTICS_HOSTNAME_PATTERN =
  /^(?:web\.runme\.dev|runme\.gateway\.[a-z0-9-]+(?:\.[a-z0-9-]+)*)$/i
const GOOGLE_ANALYTICS_SCRIPT_ID = 'runme-google-analytics'

function isValidMeasurementId(value: string | undefined): value is string {
  return typeof value === 'string' && /^G-[A-Z0-9]+$/.test(value)
}

function createAnalyticsPageContext(
  origin: string,
  hostname: string
): AnalyticsPageContext | undefined {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'https:' || url.hostname !== hostname.toLowerCase()) {
      return undefined
    }
    return {
      page_location: new URL('/', url.origin).toString(),
      page_referrer: '',
      page_title: 'Runme Web',
    }
  } catch {
    return undefined
  }
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
  private pageContext: AnalyticsPageContext | undefined

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
      origin,
    } = this.options
    const pageContext = createAnalyticsPageContext(origin, hostname)
    if (
      !isValidMeasurementId(measurementId) ||
      !GOOGLE_ANALYTICS_HOSTNAME_PATTERN.test(hostname) ||
      !pageContext ||
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
        ...pageContext,
      })
      this.pageContext = pageContext
      this.gtag = gtag
      this.sendEvent('page_view', {})
      return true
    } catch {
      this.gtag = undefined
      this.pageContext = undefined
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
    eventName: 'page_view' | 'notebook_opened' | 'cell_executed',
    params: Record<string, string>
  ): void {
    try {
      if (!this.gtag || !this.pageContext) {
        return
      }
      this.gtag?.('event', eventName, {
        ...params,
        ...this.pageContext,
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
  origin: window.location.origin,
  doNotTrack: navigator.doNotTrack,
  globalPrivacyControl: navigatorWithPrivacySignals.globalPrivacyControl,
  document,
  globalObject: window as AnalyticsGlobal,
})
