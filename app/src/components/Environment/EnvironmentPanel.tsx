import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ENVIRONMENT_PREFIX,
  listEnvironmentVariables,
  removeEnvironmentVariable,
  saveEnvironmentVariable,
  type EnvironmentVariable,
} from '../../lib/environment'

const inputClass =
  'mt-1 w-full rounded-nb-sm border border-nb-border bg-white px-2 py-1.5 font-mono text-xs text-nb-text focus:outline-none focus:ring-2 focus:ring-nb-accent'
const buttonClass =
  'rounded-nb-sm border border-nb-border px-2 py-1 text-xs font-medium text-nb-text hover:bg-nb-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nb-accent'

/** Edit origin-local user variables while keeping unsaved form input in React. */
export default function EnvironmentPanel() {
  const [variables, setVariables] = useState<EnvironmentVariable[]>([])
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const valueInput = useRef<HTMLInputElement>(null)

  const refresh = useCallback(() => {
    try {
      setVariables(listEnvironmentVariables())
      setError('')
    } catch {
      setError(
        'Could not read browser storage. Allow site storage and try again.'
      )
    }
  }, [])

  useEffect(() => {
    refresh()
    // Other tabs notify via storage; focus/Refresh also pick up browser JS edits.
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(ENVIRONMENT_PREFIX))
        refresh()
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener('focus', refresh)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])

  const resetForm = () => {
    setName('')
    setValue('')
    setEditing(false)
    setError('')
  }

  const save = (event: FormEvent) => {
    event.preventDefault()
    setStatus('')
    try {
      saveEnvironmentVariable(name.trim(), value, !editing)
      setStatus(`Saved ${name.trim()}.`)
      resetForm()
      refresh()
    } catch (cause) {
      setError(
        cause instanceof DOMException
          ? 'Could not save. Browser storage may be full or unavailable. Your input is preserved.'
          : cause instanceof Error
            ? cause.message
            : 'Could not save this variable.'
      )
    }
  }

  const remove = (variableName: string) => {
    setStatus('')
    try {
      removeEnvironmentVariable(variableName)
      if (editing && name === variableName) resetForm()
      setStatus(`Deleted ${variableName}.`)
      refresh()
    } catch {
      setError(
        'Could not delete this variable. Browser storage is unavailable.'
      )
    }
  }

  return (
    <section
      id="environment-panel"
      aria-label="Environment"
      className="h-full overflow-y-auto bg-nb-surface text-nb-text"
    >
      <header className="border-b border-nb-border px-4 py-3">
        <h2 className="text-sm font-semibold">Environment</h2>
        <p className="mt-2 text-xs leading-5 text-nb-text-muted">
          Variables for browser JavaScript cells, saved on this device for this
          Runme site. Values are plain text. Store secrets in Key Vault.
        </p>
      </header>
      <form onSubmit={save} className="space-y-3 border-b border-nb-border p-4">
        <h3 className="text-xs font-semibold">
          {editing ? 'Edit variable' : 'Add variable'}
        </h3>
        <label className="block text-xs font-medium">
          Name
          <input
            aria-label="Variable name"
            className={inputClass}
            value={name}
            readOnly={editing}
            required
            list="environment-name-suggestions"
            autoCapitalize="off"
            spellCheck={false}
            autoComplete="off"
            placeholder="OPENAI_PROJECT_ID"
            onChange={(event) => setName(event.target.value)}
          />
          <datalist id="environment-name-suggestions">
            <option value="OPENAI_ORG_ID" />
            <option value="OPENAI_PROJECT_ID" />
          </datalist>
        </label>
        <label className="block text-xs font-medium">
          Value
          <input
            aria-label="Variable value"
            ref={valueInput}
            className={inputClass}
            value={value}
            autoCapitalize="off"
            spellCheck={false}
            autoComplete="off"
            placeholder="proj_…"
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <div id="environment-form-actions" className="flex gap-2">
          <button type="submit" className={buttonClass}>
            {editing ? 'Save changes' : 'Add variable'}
          </button>
          {editing && (
            <button type="button" className={buttonClass} onClick={resetForm}>
              Cancel
            </button>
          )}
        </div>
      </form>
      <div id="environment-variables" className="space-y-3 p-4">
        {error && (
          <p role="alert" className="text-xs text-red-700">
            {error}
          </p>
        )}
        <p role="status" className="text-xs text-nb-text-muted">
          {status}
        </p>
        <button type="button" className={buttonClass} onClick={refresh}>
          Refresh variables
        </button>
        <table className="w-full table-fixed text-left text-xs">
          <caption className="sr-only">Saved environment variables</caption>
          <thead className="border-b border-nb-border text-nb-text-muted">
            <tr>
              <th scope="col" className="w-2/5 py-2">
                Name
              </th>
              <th scope="col" className="py-2">
                Value
              </th>
              <th scope="col" className="w-16 py-2">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {variables.map((variable) => (
              <tr
                key={variable.name}
                className="border-b border-nb-border align-top"
              >
                <th
                  scope="row"
                  className="break-words py-3 pr-2 font-mono font-normal"
                >
                  {variable.name}
                </th>
                <td className="whitespace-pre-wrap break-words py-3 pr-2 font-mono">
                  {variable.value || (
                    <span className="text-nb-text-faint">(empty)</span>
                  )}
                </td>
                <td className="space-y-1 py-2">
                  <button
                    type="button"
                    className={buttonClass}
                    aria-label={`Edit ${variable.name}`}
                    onClick={() => {
                      setName(variable.name)
                      setValue(variable.value)
                      setEditing(true)
                      setError('')
                      setStatus('')
                      valueInput.current?.focus()
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    aria-label={`Delete ${variable.name}`}
                    onClick={() => remove(variable.name)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {variables.length === 0 && (
              <tr>
                <td colSpan={3} className="py-4 text-nb-text-muted">
                  No variables yet. Add your OpenAI organization or project ID
                  above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <h3 className="text-xs font-semibold">Use in a JS → browser cell</h3>
        <pre className="overflow-x-auto rounded-nb-sm border border-nb-border bg-white p-2 text-xs">
          <code>{`const project = localStorage.getItem(\n  'runme.env.OPENAI_PROJECT_ID'\n)\nconst organization = localStorage.getItem(\n  'runme.env.OPENAI_ORG_ID'\n)`}</code>
        </pre>
        <p className="text-xs leading-5 text-nb-text-muted">
          Use these strings as the OpenAI-Project and OpenAI-Organization
          request headers. Variables are not automatically sent to APIs or
          synced with notebooks.
        </p>
      </div>
    </section>
  )
}
