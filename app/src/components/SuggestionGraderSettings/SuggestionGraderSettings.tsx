import { useState } from 'react'
import {
  getGraderSettings,
  saveGraderSettings,
} from '../../lib/suggestionGrader'

/** Local drafts are only persisted by Save. Secrets never populate a saved-key input. */
export function SuggestionGraderSettings() {
  const [settings, setSettings] = useState(getGraderSettings)
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [message, setMessage] = useState('')
  const save = () => {
    try {
      setSettings(
        saveGraderSettings({
          ...settings,
          apiKey: clearKey ? '' : apiKey || undefined,
        })
      )
      setApiKey('')
      setClearKey(false)
      setShowKey(false)
      setMessage('AI grader settings saved.')
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not save settings')
    }
  }
  return (
    <section
      id="suggestion-grader-settings"
      className="h-full w-full space-y-4 overflow-y-auto p-4"
    >
      <h2 className="text-lg font-semibold">AI grader</h2>
      <p className="text-sm text-nb-text-muted">
        Predict whether to accept or reject a cell change. Predictions are
        advisory; only you can accept or undo edits.
      </p>
      {(['model', 'organization', 'project'] as const).map((field) => (
        <label key={field} className="block text-sm">
          {field === 'model'
            ? 'Model ID'
            : field === 'organization'
              ? 'Organization (optional)'
              : 'Project (optional)'}
          <input
            className="mt-1 w-full rounded border border-nb-border bg-white p-2 text-nb-text"
            value={settings[field]}
            onChange={(e) =>
              setSettings({ ...settings, [field]: e.target.value })
            }
          />
        </label>
      ))}
      <label className="block text-sm">
        Grader API key (optional)
        <input
          id="grader-api-key"
          type={showKey ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          className="mt-1 w-full rounded border border-nb-border bg-white p-2 text-nb-text"
          placeholder={
            settings.hasDedicatedKey
              ? 'Dedicated key saved; enter a replacement'
              : 'Uses OpenAI key from Authentication Settings'
          }
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value)
            setClearKey(false)
          }}
        />
      </label>
      <button
        type="button"
        aria-controls="grader-api-key"
        disabled={!apiKey}
        onClick={() => setShowKey(!showKey)}
      >
        {showKey ? 'Hide' : 'Show'} entered key
      </button>
      {settings.hasDedicatedKey && (
        <label className="block text-sm">
          <input
            type="checkbox"
            checked={clearKey}
            onChange={(e) => setClearKey(e.target.checked)}
          />{' '}
          Clear dedicated key on save
        </label>
      )}
      <p className="text-xs text-nb-text-muted">
        Settings stay in this browser origin. Keys are stored unencrypted in
        localStorage, accessible to same-origin scripts and notebook code; only
        run trusted code. Keys are never written to notebooks or Drive. Requests
        go only to api.openai.com.
      </p>
      <label className="block text-sm">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) =>
            setSettings({ ...settings, enabled: e.target.checked })
          }
        />{' '}
        Enable automatic predictions when reviewing
      </label>
      <p className="text-xs text-nb-text-muted">
        Enabling sends baseline notebook text and each proposed cell change to
        OpenAI when you open Compare changes. Comments, outputs, authors and
        labels are excluded. Requests use your API key and may incur charges.
        Two requests run at a time; predictions are cached for this view only.
      </p>
      <button
        type="button"
        className="rounded bg-nb-accent px-3 py-2 text-white"
        onClick={save}
      >
        Save grader settings
      </button>
      <p role="status" className="text-sm">
        {message}
      </p>
    </section>
  )
}
