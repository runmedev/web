import { useEffect, useRef } from 'react'

import { useCurrentDoc } from '../../contexts/CurrentDocContext'
import { useWorkspaceDocumentContext } from '../../contexts/WorkspaceDocumentContext'
import {
  DOCUMENTATION_MIME_TYPE,
  getGettingStartedDocument,
  hasOpenedGettingStarted,
  markGettingStartedOpened,
} from '../../lib/documentation'

export function DocumentationInitializer() {
  const { getCurrentDoc, setCurrentDoc } = useCurrentDoc()
  const { showDocument } = useWorkspaceDocumentContext()
  const explicitDocumentRequested = useRef(
    typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).has('doc')
  )

  useEffect(() => {
    if (explicitDocumentRequested.current || hasOpenedGettingStarted()) {
      return
    }
    try {
      const document = getGettingStartedDocument()
      markGettingStartedOpened()
      showDocument(document.uri, {
        title: document.title,
        mimeType: DOCUMENTATION_MIME_TYPE,
        readOnly: true,
      })
      if (!getCurrentDoc()) {
        setCurrentDoc(document.uri)
      }
    } catch (error) {
      console.error('Failed to open Getting Started documentation', error)
    }
  }, [getCurrentDoc, setCurrentDoc, showDocument])

  return null
}

export default DocumentationInitializer
