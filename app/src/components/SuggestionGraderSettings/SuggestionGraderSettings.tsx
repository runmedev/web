import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  getGraderSettings,
  saveGraderSettings,
  readRubric,
  listRubrics,
} from '../../lib/suggestionGrader'

import { keyVault } from '../../lib/keyvault/store'
import type { ExplorerNotebook } from '../../lib/explorerNotebookSearch'

const fieldClass =
  'mt-1 block w-full rounded border border-nb-border bg-nb-surface p-2 text-nb-text'

/** Local drafts are only persisted by Save. Secrets never populate a saved-key input. */
export function SuggestionGraderSettings() {
  const [settings, setSettings] = useState(getGraderSettings)
  const vault = useSyncExternalStore(keyVault.subscribe, keyVault.getSnapshot)
  const [files, setFiles] = useState<ExplorerNotebook[]>([])
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    async function list() {
      for await (const batch of listRubrics(controller.signal)) {
        if (!controller.signal.aborted) setFiles(old => [...old, ...batch])
      }
    }
    void list().catch(() => setMessage('Unable to list mounted notebooks.'))
    return () => controller.abort()
  }, [])
  const save = async () => {
    try {
      if (settings.enabled) {
        if (!vault.names.includes(settings.keyName))
          throw new Error('Unlock Key Vault and select an API key.')
        if (!settings.instructionsUri)
          throw new Error('Select a mounted instructions notebook.')
        await readRubric(settings.instructionsUri)
      }
      setSettings(saveGraderSettings(settings))
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
      <label className="block text-sm">
        OpenAI key in Key Vault
        <select
          className={fieldClass}
          value={settings.keyName}
          onChange={(e) =>
            setSettings({ ...settings, keyName: e.target.value })
          }
        >
          <option value="">Select a key</option>
          {settings.keyName && !vault.names.includes(settings.keyName) && (
            <option value={settings.keyName}>
              {settings.keyName} (unavailable)
            </option>
          )}
          {vault.names.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </label>
      <p className="text-xs text-nb-text-muted">
        Add your OpenAI API key in Key Vault and unlock it to grade.
      </p>
      <label className="block text-sm">
        Search mounted notebooks
        <input
          className={fieldClass}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <label className="block text-sm">
        Instructions notebook
        <select
          className={fieldClass}
          value={settings.instructionsUri}
          onChange={(e) =>
            setSettings({ ...settings, instructionsUri: e.target.value })
          }
        >
          <option value="">Select a mounted .runme notebook</option>
          {settings.instructionsUri &&
            !files.some((f) => f.uri === settings.instructionsUri) && (
              <option value={settings.instructionsUri}>
                {settings.instructionsUri}
              </option>
            )}
          {files
            .filter(
              (f) =>
                f.uri === settings.instructionsUri ||
                (f.folder + '/' + f.name)
                  .toLowerCase()
                  .includes(query.toLowerCase())
            )
            .map((f) => (
              <option key={f.uri} value={f.uri}>
                {[f.folder, f.name].filter(Boolean).join('/')}
              </option>
            ))}
        </select>
      </label>
      {(['organization', 'project'] as const).map((field) => (
        <label key={field} className="block text-sm">
          {field === 'organization'
            ? 'Organization (optional)'
            : 'Project (optional)'}
          <input
            className={fieldClass}
            value={settings[field]}
            onChange={(e) =>
              setSettings({ ...settings, [field]: e.target.value })
            }
          />
        </label>
      ))}
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
        Grading sends the selected Markdown instructions, baseline text and
        proposed change to OpenAI when you open Compare changes. Comments,
        outputs, authors and labels are excluded. Requests use your API key and
        may incur charges. Two requests run at a time; predictions are cached
        for this view only.
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
