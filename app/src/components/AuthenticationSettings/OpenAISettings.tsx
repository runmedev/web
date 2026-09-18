import { useState } from 'react'
import {
  clearOpenAIAuth,
  getOpenAIAuthStatus,
  revealOpenAIKeyForSettings,
  saveOpenAIAuth,
} from '../../lib/openaiTraining'

/** Independent save action: unrelated Google/OIDC validation must not block this key. */
export function OpenAISettings() {
  const [status, setStatus] = useState(getOpenAIAuthStatus)
  const [apiKey, setApiKey] = useState('')
  // Keep the saved secret out of the input until explicitly revealed. Revealing
  // must not turn it into a draft replacement or enable the Save action.
  const [showApiKey, setShowApiKey] = useState(false)
  const [revealedSavedKey, setRevealedSavedKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(status.baseUrl)
  const [message, setMessage] = useState('')
  const inputClass =
    'mt-1 w-full rounded-nb-sm border border-nb-border bg-white px-3 py-2 text-sm text-nb-text'
  const act = (clear: boolean) => {
    try {
      if (clear) clearOpenAIAuth()
      else saveOpenAIAuth(apiKey, baseUrl)
      setApiKey('')
      setShowApiKey(false)
      setRevealedSavedKey('')
      setStatus(getOpenAIAuthStatus())
      setMessage(clear ? 'OpenAI API key cleared.' : 'OpenAI API key saved.')
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Could not update OpenAI settings'
      )
    }
  }
  return (
    <section
      id="openai-authentication-settings"
      className="space-y-3 border-b border-nb-border p-4"
    >
      <h3 className="text-sm font-semibold text-nb-text">OpenAI API</h3>
      <p className="text-xs text-nb-text-muted">
        Used only when you explicitly upload a dataset or submit/check a
        training job.
      </p>
      <label className="block text-xs font-semibold text-nb-text">
        OpenAI API endpoint
        <input
          className={inputClass}
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </label>
      <label className="block text-xs font-semibold text-nb-text">
        OpenAI API key
        <input
          className={inputClass}
          id="openai-api-key"
          type={showApiKey ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          value={apiKey || revealedSavedKey}
          onChange={(event) => {
            setApiKey(event.target.value)
            setRevealedSavedKey('')
          }}
          placeholder={
            status.configured
              ? 'Key saved; enter a replacement'
              : 'Enter API key'
          }
        />
      </label>
      <button
        type="button"
        className="rounded-nb-sm border border-nb-border px-3 py-2 text-sm disabled:opacity-50"
        aria-controls="openai-api-key"
        disabled={!showApiKey && !status.configured && !apiKey}
        onClick={() => {
          setRevealedSavedKey(
            !showApiKey && !apiKey ? revealOpenAIKeyForSettings() : ''
          )
          setShowApiKey(!showApiKey)
        }}
      >
        {showApiKey ? 'Hide OpenAI key' : 'Show OpenAI key'}
      </button>
      <p className="text-xs text-nb-text-muted">
        Stored unencrypted in localStorage for this browser origin, not in
        notebooks or Google Drive. Same-origin scripts and executed notebook
        code can access it. Only run trusted code. Localhost and web.runme.dev
        have separate settings.
      </p>
      <div id="openai-key-actions" className="flex gap-2">
        <button
          type="button"
          className="rounded-nb-sm bg-nb-accent px-3 py-2 text-sm text-white disabled:opacity-50"
          disabled={!apiKey.trim()}
          onClick={() => act(false)}
        >
          Save OpenAI key
        </button>
        <button
          type="button"
          className="rounded-nb-sm border border-nb-border px-3 py-2 text-sm disabled:opacity-50"
          disabled={!status.configured}
          onClick={() => act(true)}
        >
          Clear OpenAI key
        </button>
      </div>
      <p role="status" className="text-xs text-nb-text-muted">
        {message ||
          (status.configured
            ? 'An OpenAI key is saved.'
            : 'No OpenAI key saved.')}
      </p>
    </section>
  )
}
