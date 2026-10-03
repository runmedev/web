import { useEffect, useState, useSyncExternalStore } from 'react'

import { keyVault, type KeyVault } from '../../lib/keyvault/store'
import SecretInput from '../SecretInput'

const inputClass =
  'mt-1 w-full rounded-nb-sm border border-nb-border bg-nb-surface px-2 py-2 text-sm text-nb-text'
const buttonClass =
  'rounded-nb-sm border border-nb-border px-3 py-2 text-sm disabled:opacity-50'

/** The sidebar owns secret input fields; unmounting or locking clears those drafts. */
export default function KeyVaultPanel({
  vault = keyVault,
}: {
  vault?: KeyVault
}) {
  const snapshot = useSyncExternalStore(vault.subscribe, vault.getSnapshot)
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [editing, setEditing] = useState<string>()
  const [deleting, setDeleting] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    try {
      vault.refresh()
    } catch {
      setError('Browser storage is unavailable.')
    }
  }, [vault])
  useEffect(() => {
    if (snapshot.status !== 'unlocked') {
      setValue('')
      setName('')
      setEditing(undefined)
      setDeleting(undefined)
    }
  }, [snapshot.status])

  /** Report only controlled vault errors; never log inputs or include them in outputs. */
  async function act(work: () => Promise<void>) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await work()
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Vault operation failed.'
      )
    } finally {
      setBusy(false)
      setPassphrase('')
      setConfirmation('')
      setValue('')
    }
  }

  return (
    <div
      id="key-vault-panel"
      className="flex h-full min-h-0 flex-col bg-nb-surface text-nb-text"
    >
      <header className="border-b border-nb-border px-4 py-3">
        <h2 className="text-sm font-semibold">Key Vault</h2>
        <p className="mt-1 text-xs text-nb-text-muted">
          Named keys for your notebook integrations.
        </p>
      </header>
      <div id="key-vault-content" className="space-y-4 overflow-y-auto p-4">
        <p className="text-xs leading-5 text-nb-text-muted">
          Encrypted in this browser for this Runme site. Keys are never included
          in notebook files or Drive sync.
        </p>
        {snapshot.status !== 'unlocked' ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              void act(async () => {
                if (snapshot.status === 'new' && passphrase !== confirmation)
                  throw new Error('Passphrases do not match.')
                await vault.unlock(passphrase, snapshot.status === 'new')
              })
            }}
          >
            <p className="text-sm">
              {snapshot.status === 'new'
                ? 'Create a vault with a passphrase. You will use it to unlock your keys after reopening Runme.'
                : 'Unlock your saved keys for this tab.'}
            </p>
            <SecretInput
              label="Vault passphrase"
              autoComplete={
                snapshot.status === 'new' ? 'new-password' : 'current-password'
              }
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              required
              disabled={busy}
              minLength={snapshot.status === 'new' ? 12 : undefined}
            />
            {snapshot.status === 'new' && (
              <>
                <SecretInput
                  label="Confirm passphrase"
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  required
                  disabled={busy}
                />
                <p className="text-xs text-nb-text-muted">
                  Use at least 12 characters. Keep the passphrase safe: Runme
                  cannot recover it. Clearing this site's browser data removes
                  the vault.
                </p>
              </>
            )}
            <button className={buttonClass} disabled={busy} type="submit">
              {busy
                ? 'Unlocking…'
                : snapshot.status === 'new'
                  ? 'Create vault'
                  : 'Unlock vault'}
            </button>
          </form>
        ) : (
          <>
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                vault.lock()
                setNotice('')
                setError('')
              }}
            >
              Lock vault
            </button>
            <p className="text-xs text-nb-text-muted">
              Unlocked for this tab. Run only trusted browser JavaScript while
              your keys are available.
            </p>
            <ul className="space-y-2" aria-label="Saved keys">
              {snapshot.names.map((key) => (
                <li
                  key={key}
                  className="rounded-nb-sm border border-nb-border p-2"
                >
                  <p className="break-all font-mono text-sm">{key}</p>
                  <div
                    id={`key-vault-actions-${encodeURIComponent(key)}`}
                    className="mt-2 flex flex-wrap gap-2"
                  >
                    <button
                      className={buttonClass}
                      type="button"
                      disabled={busy}
                      aria-label={`Edit ${key}`}
                      onClick={() => {
                        setName(key)
                        setValue('')
                        setEditing(key)
                        setDeleting(undefined)
                        setError('')
                        setNotice('')
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className={buttonClass}
                      type="button"
                      disabled={busy}
                      aria-label={`Delete ${key}`}
                      onClick={() => setDeleting(key)}
                    >
                      Delete
                    </button>
                  </div>
                  {deleting === key && (
                    <div
                      id="key-vault-delete-confirmation"
                      className="mt-2 space-y-2"
                    >
                      <p className="text-xs">
                        Remove this saved key? Keep a copy if you will need it
                        again.
                      </p>
                      <button
                        className={buttonClass}
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await vault.deleteKey(key)
                            setDeleting(undefined)
                            if (editing === key) {
                              setEditing(undefined)
                              setName('')
                            }
                            setNotice('Key removed.')
                          })
                        }
                      >
                        Confirm removal
                      </button>
                      <button
                        className={buttonClass}
                        type="button"
                        onClick={() => setDeleting(undefined)}
                      >
                        Cancel removal
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {!snapshot.names.length && (
              <p className="text-sm">
                No keys yet. Add your first named key below.
              </p>
            )}
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                void act(async () => {
                  await vault.saveKey(name, value, editing)
                  setName('')
                  setEditing(undefined)
                  setNotice('Key saved.')
                })
              }}
            >
              <h3 className="text-sm font-semibold">
                {editing ? 'Edit key' : 'Add a key'}
              </h3>
              <label className="block text-sm">
                Key name
                <input
                  className={inputClass}
                  value={name}
                  placeholder="openai-api"
                  maxLength={128}
                  required
                  disabled={busy}
                  autoComplete="off"
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <SecretInput
                key={editing ? `edit:${editing}` : 'new-key'}
                label="Key value"
                value={value}
                required={!editing}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setValue(e.target.value)}
              />
              {editing && (
                <p className="text-xs text-nb-text-muted">
                  Leave the value empty to keep the existing key.
                </p>
              )}
              <button type="submit" className={buttonClass} disabled={busy}>
                {busy ? 'Saving…' : 'Save key'}
              </button>
              {editing && (
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy}
                  onClick={() => {
                    setEditing(undefined)
                    setName('')
                    setValue('')
                  }}
                >
                  Cancel edit
                </button>
              )}
            </form>
            <p className="text-xs text-nb-text-muted">
              Use in a browser JS cell:
            </p>
            <pre className="whitespace-pre-wrap break-all text-xs">
              {'agents.setKey(keyvault.getKey("openai-api"))'}
            </pre>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
      </div>
    </div>
  )
}
