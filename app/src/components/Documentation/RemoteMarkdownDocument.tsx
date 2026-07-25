import { ArrowTopRightOnSquareIcon } from '@heroicons/react/20/solid'
import { Button, ScrollArea } from '@radix-ui/themes'
import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { useCurrentDoc } from '../../contexts/CurrentDocContext'
import { useWorkspaceDocumentContext } from '../../contexts/WorkspaceDocumentContext'
import {
  DOCUMENTATION_MIME_TYPE,
  fetchRemoteMarkdownDocument,
  isRemoteMarkdownUri,
  markDocumentationOpened,
  resolveDocumentationHref,
  toRawMarkdownUri,
} from '../../lib/documentation'
import type { WorkspaceDocument } from '../../lib/workspaceDocuments/workspaceDocumentTypes'

export function RemoteMarkdownDocument({
  document,
}: {
  document: WorkspaceDocument
}) {
  const { setCurrentDoc } = useCurrentDoc()
  const { showDocument } = useWorkspaceDocumentContext()
  const [content, setContent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void fetchRemoteMarkdownDocument(document.uri, (input, init) =>
      fetch(input, { ...init, signal: controller.signal })
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setContent(result.content)
          setLoading(false)
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause))
          setLoading(false)
        }
      })
    return () => controller.abort()
  }, [attempt, document.uri])

  const openMarkdownLink = useCallback(
    (uri: string) => {
      markDocumentationOpened(uri)
      showDocument(uri, {
        title:
          decodeURIComponent(
            new URL(uri).pathname.split('/').filter(Boolean).pop() ||
              'Documentation'
          ).replace(/\.md$/i, '') || 'Documentation',
        mimeType: DOCUMENTATION_MIME_TYPE,
        readOnly: true,
      })
      setCurrentDoc(uri)
    },
    [setCurrentDoc, showDocument]
  )

  const components = useMemo<Components>(
    () => ({
      h1: ({ children, ...props }) => (
        <h1 className="mb-4 mt-6 text-3xl font-bold text-nb-text" {...props}>
          {children}
        </h1>
      ),
      h2: ({ children, ...props }) => (
        <h2 className="mb-3 mt-7 text-2xl font-bold text-nb-text" {...props}>
          {children}
        </h2>
      ),
      h3: ({ children, ...props }) => (
        <h3 className="mb-2 mt-6 text-xl font-semibold text-nb-text" {...props}>
          {children}
        </h3>
      ),
      p: ({ children, ...props }) => (
        <p className="mb-4 leading-7 text-nb-text" {...props}>
          {children}
        </p>
      ),
      ul: ({ children, ...props }) => (
        <ul className="mb-4 ml-6 list-disc space-y-1 text-nb-text" {...props}>
          {children}
        </ul>
      ),
      ol: ({ children, ...props }) => (
        <ol
          className="mb-4 ml-6 list-decimal space-y-1 text-nb-text"
          {...props}
        >
          {children}
        </ol>
      ),
      code: ({ children, className, ...props }) =>
        className ? (
          <code
            className={`${className} block overflow-x-auto rounded-md bg-nb-surface-2 p-3 font-mono text-sm`}
            {...props}
          >
            {children}
          </code>
        ) : (
          <code
            className="rounded bg-nb-surface-2 px-1.5 py-0.5 font-mono text-sm"
            {...props}
          >
            {children}
          </code>
        ),
      pre: ({ children, ...props }) => (
        <pre className="mb-4 overflow-x-auto" {...props}>
          {children}
        </pre>
      ),
      blockquote: ({ children, ...props }) => (
        <blockquote
          className="my-4 border-l-4 border-nb-border-strong pl-4 text-nb-text-muted"
          {...props}
        >
          {children}
        </blockquote>
      ),
      a: ({ children, href, ...props }) => {
        if (!href) {
          return <a {...props}>{children}</a>
        }
        const resolved = href.startsWith('#')
          ? href
          : resolveDocumentationHref(href, document.uri)
        const opensDocumentation =
          !resolved.startsWith('#') && isRemoteMarkdownUri(resolved)
        return (
          <a
            href={resolved}
            className="text-blue-600 hover:underline"
            target={opensDocumentation ? undefined : '_blank'}
            rel={opensDocumentation ? undefined : 'noopener noreferrer'}
            onClick={
              opensDocumentation
                ? (event) => {
                    event.preventDefault()
                    openMarkdownLink(resolved)
                  }
                : undefined
            }
            {...props}
          >
            {children}
          </a>
        )
      },
      img: ({ src, alt, ...props }) => {
        const resolved = src
          ? toRawMarkdownUri(resolveDocumentationHref(src, document.uri))
          : undefined
        return (
          <img
            src={resolved}
            alt={alt || ''}
            className="my-4 h-auto max-w-full rounded-md"
            {...props}
          />
        )
      },
      table: ({ children, ...props }) => (
        <div className="mb-4 overflow-x-auto">
          <table
            className="min-w-full border border-nb-border-strong"
            {...props}
          >
            {children}
          </table>
        </div>
      ),
      th: ({ children, ...props }) => (
        <th
          className="border border-nb-border-strong bg-nb-surface-2 px-3 py-2 text-left font-semibold"
          {...props}
        >
          {children}
        </th>
      ),
      td: ({ children, ...props }) => (
        <td className="border border-nb-border-strong px-3 py-2" {...props}>
          {children}
        </td>
      ),
    }),
    [document.uri, openMarkdownLink]
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-nb-border bg-nb-surface px-4 py-2">
        <span className="truncate text-xs text-nb-text-muted">
          Read-only · {document.uri}
        </span>
        <a
          href={document.uri}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 text-xs text-blue-600 hover:underline"
        >
          View on GitHub
          <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
        </a>
      </div>
      <ScrollArea type="auto" scrollbars="vertical" className="min-h-0 flex-1">
        <article className="mx-auto max-w-4xl px-8 py-6">
          {loading ? (
            <p className="text-sm text-nb-text-muted">Loading documentation…</p>
          ) : error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
              <p>{error}</p>
              <Button
                type="button"
                variant="soft"
                color="red"
                className="mt-3"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Retry
              </Button>
            </div>
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
              {content}
            </ReactMarkdown>
          )}
        </article>
      </ScrollArea>
    </div>
  )
}

export default RemoteMarkdownDocument
