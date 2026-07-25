import { useEffect, useRef } from 'react'

import { useCurrentDoc } from '../../contexts/CurrentDocContext'
import { useWorkspaceDocumentContext } from '../../contexts/WorkspaceDocumentContext'
import {
  hasOpenedOnboarding,
  markOnboardingOpened,
  ONBOARDING_DOCUMENT_URI,
  ONBOARDING_MIME_TYPE,
} from '../../lib/onboarding'

export function OnboardingInitializer() {
  const { getCurrentDoc, setCurrentDoc } = useCurrentDoc()
  const { showDocument } = useWorkspaceDocumentContext()
  const explicitDocumentRequested = useRef(
    typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).has('doc')
  )

  useEffect(() => {
    if (explicitDocumentRequested.current || hasOpenedOnboarding()) {
      return
    }
    markOnboardingOpened()
    showDocument(ONBOARDING_DOCUMENT_URI, {
      title: 'Welcome to Runme',
      mimeType: ONBOARDING_MIME_TYPE,
      readOnly: true,
    })
    if (!getCurrentDoc()) {
      setCurrentDoc(ONBOARDING_DOCUMENT_URI)
    }
  }, [getCurrentDoc, setCurrentDoc, showDocument])

  return null
}

export default OnboardingInitializer
