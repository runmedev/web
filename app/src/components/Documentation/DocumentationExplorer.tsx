import {
  BookOpenIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DocumentTextIcon,
} from '@heroicons/react/24/outline'
import { useMemo, useState } from 'react'

import { useCurrentDoc } from '../../contexts/CurrentDocContext'
import { useWorkspaceDocumentContext } from '../../contexts/WorkspaceDocumentContext'
import {
  DOCUMENTATION_MIME_TYPE,
  listDocumentation,
  markDocumentationOpened,
} from '../../lib/documentation'
import {
  markOnboardingOpened,
  ONBOARDING_DOCUMENT_URI,
  ONBOARDING_MIME_TYPE,
} from '../../lib/onboarding'

export function DocumentationExplorer() {
  const [expanded, setExpanded] = useState(true)
  const { getCurrentDoc, setCurrentDoc } = useCurrentDoc()
  const { showDocument } = useWorkspaceDocumentContext()
  const currentDoc = getCurrentDoc()
  const result = useMemo(() => {
    try {
      return { documents: listDocumentation(), error: null }
    } catch (error) {
      return {
        documents: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }, [])

  return (
    <div
      id="documentation-explorer"
      className="flex h-full min-h-0 w-full flex-col bg-nb-surface"
    >
      <div className="border-b border-nb-border px-4 py-3">
        <p className="text-xs font-semibold tracking-[0.18em] text-nb-text-faint uppercase">
          Documentation
        </p>
        <p className="mt-1 text-sm text-nb-text-muted">
          Versioned with this Runme build
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <button
          type="button"
          className={`mb-2 flex w-full items-center gap-2 rounded-nb-sm border px-2 py-2 text-left text-sm font-medium transition-colors ${
            currentDoc === ONBOARDING_DOCUMENT_URI
              ? 'border-nb-accent bg-nb-accent-soft text-nb-text'
              : 'border-nb-border bg-white/70 text-nb-text-muted hover:bg-white hover:text-nb-text'
          }`}
          onClick={() => {
            markOnboardingOpened()
            showDocument(ONBOARDING_DOCUMENT_URI, {
              title: 'Welcome to Runme',
              mimeType: ONBOARDING_MIME_TYPE,
              readOnly: true,
            })
            setCurrentDoc(ONBOARDING_DOCUMENT_URI)
          }}
        >
          <DocumentTextIcon className="h-4 w-4 shrink-0" />
          <span className="truncate">Welcome to Runme</span>
        </button>
        {result.error ? (
          <div className="rounded-nb-sm border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
            {result.error}
          </div>
        ) : (
          <div role="tree" aria-label="Runme documentation">
            <button
              type="button"
              role="treeitem"
              aria-expanded={expanded}
              className="flex w-full items-center gap-1.5 rounded-nb-sm px-2 py-1.5 text-left text-sm font-semibold text-nb-text hover:bg-white/80"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? (
                <ChevronDownIcon className="h-4 w-4 shrink-0" />
              ) : (
                <ChevronRightIcon className="h-4 w-4 shrink-0" />
              )}
              <BookOpenIcon className="h-4 w-4 shrink-0" />
              <span>Runme Web</span>
            </button>
            {expanded ? (
              <div role="group" className="ml-4 border-l border-nb-border pl-1">
                {result.documents.map((document) => {
                  const selected = currentDoc === document.uri
                  return (
                    <button
                      key={document.path}
                      type="button"
                      role="treeitem"
                      aria-selected={selected}
                      title={document.uri}
                      className={`flex w-full items-center gap-2 rounded-nb-sm px-2 py-1.5 text-left text-sm transition-colors ${
                        selected
                          ? 'bg-nb-accent-soft text-nb-text'
                          : 'text-nb-text-muted hover:bg-white/80 hover:text-nb-text'
                      }`}
                      onClick={() => {
                        markDocumentationOpened(document.uri)
                        showDocument(document.uri, {
                          title: document.title,
                          mimeType: DOCUMENTATION_MIME_TYPE,
                          readOnly: true,
                        })
                        setCurrentDoc(document.uri)
                      }}
                    >
                      <DocumentTextIcon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{document.title}</span>
                    </button>
                  )
                })}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

export default DocumentationExplorer
