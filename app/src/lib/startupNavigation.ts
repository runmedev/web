/** Preserve explicit URL intent across asynchronous bootstrap and URL cleanup. */
let explicitDocumentRequested = false

export function captureStartupDocumentRequest(): void {
  explicitDocumentRequested = new URLSearchParams(window.location.search).has(
    'doc'
  )
}

/** Initializers must not steal focus after a coordinator consumes the doc query. */
export function hasStartupDocumentRequest(): boolean {
  return (
    explicitDocumentRequested ||
    new URLSearchParams(window.location.search).has('doc')
  )
}
