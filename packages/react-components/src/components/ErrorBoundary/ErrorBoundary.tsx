import { Component, ErrorInfo, ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
  suppressHydrationErrors?: boolean
  logErrors?: boolean
  onError?: (error: Error, errorInfo: ErrorInfo) => void
}

interface ErrorBoundaryState {
  hasError: boolean
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(_error: Error): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const isHydrationError =
      error.message.includes('Hydration') ||
      error.message.includes('hydration') ||
      error.message.includes('Text content does not match') ||
      error.message.includes('cannot appear as a descendant')

    if (this.props.suppressHydrationErrors && isHydrationError) {
      if (this.props.logErrors && import.meta.env.DEV) {
        console.debug(
          '[ErrorBoundary] Suppressed hydration error:',
          error.message
        )
      }
      return
    }

    if (this.props.logErrors) {
      console.error('[ErrorBoundary] Caught error:', error, errorInfo)
    }

    if (this.props.onError) {
      this.props.onError(error, errorInfo)
    }
  }

  render() {
    return this.props.children
  }
}
