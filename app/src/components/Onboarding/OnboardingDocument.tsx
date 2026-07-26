import {
  ArrowTopRightOnSquareIcon,
  BookOpenIcon,
  CheckCircleIcon,
  ClipboardDocumentIcon,
  CloudArrowUpIcon,
  CodeBracketSquareIcon,
  DocumentPlusIcon,
  DocumentTextIcon,
  FolderPlusIcon,
  PlayCircleIcon,
  ShareIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline'
import {
  type ComponentType,
  type SVGProps,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'

import { useCurrentDoc } from '../../contexts/CurrentDocContext'
import { useGoogleAuth } from '../../contexts/GoogleAuthContext'
import { useSidePanel } from '../../contexts/SidePanelContext'
import { useWorkspaceDocumentContext } from '../../contexts/WorkspaceDocumentContext'
import {
  DOCUMENTATION_MIME_TYPE,
  getGettingStartedDocument,
  markDocumentationOpened,
} from '../../lib/documentation'
import { copyNotebookMarkdownLink } from '../../lib/shareLinks'
import { showToast } from '../../lib/toast'
import {
  dismissOnboarding,
  getOnboardingStateSnapshot,
  markOnboardingOpened,
  ONBOARDING_DOCUMENT_URI,
  parseOnboardingState,
  subscribeToOnboardingState,
  type OnboardingTaskId,
} from '../../lib/onboarding'
import { GoogleDrivePickerButton } from '../Workspace/GoogleDrivePickerButton'

const CODEX_URL = 'https://chatgpt.com/codex'
const CODEX_PROMPT =
  "Open https://web.runme.dev in @Browser. Create a notebook with today's forecast for where I live. Document how you obtained today's forecast."

type TaskDefinition = {
  id: OnboardingTaskId
  title: string
  description: string
  actionLabel: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
}

const TASKS: TaskDefinition[] = [
  {
    id: 'read-getting-started',
    title: 'Read the Getting Started guide',
    description:
      'Learn the editor, runners, and sharing model in a few minutes.',
    actionLabel: 'Open guide',
    icon: BookOpenIcon,
  },
  {
    id: 'sign-in-google-drive',
    title: 'Sign in to Google Drive',
    description: 'Keep notebooks available across browsers and devices.',
    actionLabel: 'Sign in',
    icon: CloudArrowUpIcon,
  },
  {
    id: 'add-drive-folder',
    title: 'Add a Drive folder',
    description: 'Choose where Runme should organize your shared documents.',
    actionLabel: 'Choose folder',
    icon: FolderPlusIcon,
  },
  {
    id: 'create-first-notebook',
    title: 'Create your first notebook',
    description: 'Start a design doc, runbook, or lightweight workflow.',
    actionLabel: 'Open Explorer',
    icon: DocumentPlusIcon,
  },
  {
    id: 'run-first-cell',
    title: 'Run your first cell',
    description: 'Mix narrative and executable steps in the same document.',
    actionLabel: 'Open Explorer',
    icon: PlayCircleIcon,
  },
  {
    id: 'share-notebook',
    title: 'Share the notebook',
    description:
      'Copy a Markdown link so a teammate or AI agent can work from the same context.',
    actionLabel: 'Copy Link',
    icon: ShareIcon,
  },
]

function useOnboardingState() {
  const snapshot = useSyncExternalStore(
    subscribeToOnboardingState,
    getOnboardingStateSnapshot,
    () => ''
  )
  return useMemo(() => parseOnboardingState(snapshot), [snapshot])
}

export function OnboardingDocument() {
  const onboardingState = useOnboardingState()
  const { setCurrentDoc } = useCurrentDoc()
  const { setPanel } = useSidePanel()
  const { startGoogleDriveOAuth } = useGoogleAuth()
  const { showDocument, closeWorkspaceDocument } = useWorkspaceDocumentContext()
  const [copiedPrompt, setCopiedPrompt] = useState(false)
  const [authBusy, setAuthBusy] = useState(false)
  const [shareBusy, setShareBusy] = useState(false)
  const [copiedNotebookLink, setCopiedNotebookLink] = useState(false)

  const completedTaskIds = useMemo(
    () => new Set(onboardingState.completedTaskIds),
    [onboardingState.completedTaskIds]
  )
  const completedCount = completedTaskIds.size
  const progress = Math.round((completedCount / TASKS.length) * 100)

  const openGettingStarted = () => {
    const document = getGettingStartedDocument()
    markDocumentationOpened(document.uri)
    showDocument(document.uri, {
      title: document.title,
      mimeType: DOCUMENTATION_MIME_TYPE,
      readOnly: true,
    })
    setCurrentDoc(document.uri)
  }

  const handleTaskAction = (taskId: OnboardingTaskId) => {
    if (taskId === 'read-getting-started') {
      openGettingStarted()
      return
    }
    if (taskId === 'sign-in-google-drive') {
      setAuthBusy(true)
      void startGoogleDriveOAuth()
        .catch((error) => {
          console.error('Failed to start Google Drive sign-in', error)
        })
        .finally(() => setAuthBusy(false))
      return
    }
    setPanel('explorer')
  }

  const copyCodexPrompt = async () => {
    await navigator.clipboard.writeText(CODEX_PROMPT)
    setCopiedPrompt(true)
    window.setTimeout(() => setCopiedPrompt(false), 2_000)
  }

  const copyRecentNotebookLink = async () => {
    const notebook = onboardingState.recentNotebook
    if (!notebook?.remoteUri) {
      return
    }
    setShareBusy(true)
    try {
      await copyNotebookMarkdownLink(notebook.name, notebook.remoteUri)
      setCopiedNotebookLink(true)
      showToast({ message: 'Markdown link copied', tone: 'success' })
      window.setTimeout(() => setCopiedNotebookLink(false), 2_000)
    } catch (error) {
      console.error('Failed to copy onboarding notebook link', error)
      showToast({
        message: 'Could not copy the notebook link',
        tone: 'error',
      })
    } finally {
      setShareBusy(false)
    }
  }

  const dismiss = () => {
    dismissOnboarding()
    closeWorkspaceDocument(ONBOARDING_DOCUMENT_URI)
  }

  return (
    <div
      className="h-full overflow-y-auto bg-[radial-gradient(circle_at_top_left,_rgba(99,102,241,0.12),_transparent_34%),linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)]"
      data-testid="onboarding-document"
    >
      <main className="mx-auto w-full max-w-6xl px-6 py-10 lg:px-10 lg:py-14">
        <section className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr] lg:items-start">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-semibold tracking-wide text-indigo-700 uppercase">
              <SparklesIcon className="h-4 w-4" />
              Welcome to Runme
            </div>
            <h1 className="mt-5 max-w-3xl text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
              Document, Share, Learn
            </h1>
            <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-600">
              Use Runme to collaborate with your AI on notebooks stored in
              Google Drive. Ask your AI to document how it accomplishes tasks.
              Share those documents with your colleagues (and their AIs) so they
              can learn.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={openGettingStarted}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
              >
                <BookOpenIcon className="h-5 w-5" />
                Read Getting Started
              </button>
              <button
                type="button"
                onClick={() => setPanel('explorer')}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-50"
              >
                <DocumentPlusIcon className="h-5 w-5" />
                Create a notebook
              </button>
            </div>
          </div>

          <aside className="overflow-hidden rounded-2xl border border-indigo-200 bg-slate-950 p-6 text-white shadow-xl shadow-indigo-100/80">
            <div className="flex items-center gap-2 text-sm font-semibold text-indigo-200">
              <CodeBracketSquareIcon className="h-5 w-5" />
              Try Runme with Codex
            </div>
            <h2 className="mt-3 text-2xl font-semibold">
              Document What Codex Does
            </h2>
            <p className="mt-3 text-sm leading-6 text-slate-300">
              Open Codex, launch Runme in its in-app Browser, and ask it to
              document a simple task as a runnable notebook.
            </p>
            <div className="mt-5 rounded-lg border border-white/10 bg-white/5 p-3 font-mono text-xs leading-5 text-slate-200">
              {CODEX_PROMPT}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <a
                href={CODEX_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-500 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400"
              >
                Open Codex
                <ArrowTopRightOnSquareIcon className="h-4 w-4" />
              </a>
              <button
                type="button"
                onClick={() => void copyCodexPrompt()}
                className="inline-flex items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-white/15"
              >
                <ClipboardDocumentIcon className="h-4 w-4" />
                {copiedPrompt ? 'Prompt copied' : 'Copy Codex prompt'}
              </button>
            </div>
          </aside>
        </section>

        <section className="mt-12 grid gap-5 md:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <DocumentTextIcon className="h-7 w-7 text-indigo-600" />
            <h2 className="mt-4 text-lg font-semibold text-slate-950">
              Design docs that stay actionable
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Develop decisions with an agent, keep evidence beside the
              proposal, and hand teammates one durable document.
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <PlayCircleIcon className="h-7 w-7 text-emerald-600" />
            <h2 className="mt-4 text-lg font-semibold text-slate-950">
              Runbooks people can actually run
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Explain the workflow in Markdown, execute its steps in cells, and
              share a repeatable operational playbook.
            </p>
          </div>
        </section>

        <section className="mt-10 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold tracking-[0.16em] text-indigo-600 uppercase">
                Your first Runme
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                Six steps to a shared notebook
              </h2>
            </div>
            <p className="text-sm font-medium text-slate-600">
              {completedCount} of {TASKS.length} complete
            </p>
          </div>
          <div
            className="mt-5 h-2 overflow-hidden rounded-full bg-slate-100"
            aria-label={`${progress}% complete`}
          >
            <div
              className="h-full rounded-full bg-indigo-500 transition-[width]"
              style={{ width: `${progress}%` }}
            />
          </div>

          <ol className="mt-7 grid gap-3 lg:grid-cols-2">
            {TASKS.map((task, index) => {
              const complete = completedTaskIds.has(task.id)
              const Icon = task.icon
              return (
                <li
                  key={task.id}
                  className={`flex gap-4 rounded-xl border p-4 ${
                    complete
                      ? 'border-emerald-200 bg-emerald-50/60'
                      : 'border-slate-200 bg-white'
                  }`}
                >
                  <div
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                      complete
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {complete ? (
                      <CheckCircleIcon className="h-6 w-6" />
                    ) : (
                      <span className="text-sm font-semibold">{index + 1}</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Icon className="h-5 w-5 shrink-0 text-slate-500" />
                      <h3 className="font-semibold text-slate-900">
                        {task.title}
                      </h3>
                    </div>
                    <p className="mt-1 text-sm leading-5 text-slate-600">
                      {task.description}
                    </p>
                    {(task.id === 'share-notebook' || !complete) &&
                      (task.id === 'add-drive-folder' ? (
                        <GoogleDrivePickerButton
                          label={task.actionLabel}
                          className="mt-3 inline-flex rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        />
                      ) : task.id === 'share-notebook' ? (
                        <button
                          type="button"
                          disabled={
                            !onboardingState.recentNotebook?.remoteUri ||
                            shareBusy
                          }
                          title={
                            onboardingState.recentNotebook?.remoteUri
                              ? `Copy a Markdown link to ${onboardingState.recentNotebook.name}`
                              : 'Create a notebook in Google Drive to enable sharing'
                          }
                          onClick={() => void copyRecentNotebookLink()}
                          className="mt-3 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
                        >
                          {shareBusy
                            ? 'Copying…'
                            : copiedNotebookLink
                              ? 'Copied!'
                              : task.actionLabel}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={
                            task.id === 'sign-in-google-drive' && authBusy
                          }
                          onClick={() => handleTaskAction(task.id)}
                          className="mt-3 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
                        >
                          {task.id === 'sign-in-google-drive' && authBusy
                            ? 'Starting sign in…'
                            : task.actionLabel}
                        </button>
                      ))}
                  </div>
                </li>
              )
            })}
          </ol>
        </section>

        <div className="mt-8 flex items-center justify-between gap-4 border-t border-slate-200 pt-6">
          <p className="text-sm text-slate-500">
            You can reopen this page anytime from Documentation.
          </p>
          <button
            type="button"
            onClick={dismiss}
            className="text-sm font-semibold text-slate-600 hover:text-slate-950"
          >
            Not now
          </button>
        </div>
      </main>
    </div>
  )
}

export function showOnboardingDocument(
  showDocument: ReturnType<typeof useWorkspaceDocumentContext>['showDocument'],
  setCurrentDoc: ReturnType<typeof useCurrentDoc>['setCurrentDoc']
) {
  markOnboardingOpened()
  showDocument(ONBOARDING_DOCUMENT_URI, {
    title: 'Welcome to Runme',
    mimeType: 'application/vnd.runme.onboarding',
    readOnly: true,
  })
  setCurrentDoc(ONBOARDING_DOCUMENT_URI)
}

export default OnboardingDocument
