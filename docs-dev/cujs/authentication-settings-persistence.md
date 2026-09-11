# Authentication settings survive refresh

## Journey

Open Authentication Settings, add `email` to Runme OAuth scopes, and save.
Refresh twice. The scope field and the OIDC runtime must retain exactly the saved
value. Saving must not initiate authorization.

## Root cause and design

Production startup normally reapplies deployment YAML to local OAuth settings.
The settings panel previously saved the clients but did not enable local
precedence, so the next preload silently replaced the saved scopes. Development
already defaults to local precedence, hiding the production failure.

An explicit settings save, or authorization after editing OAuth fields, now enables
the existing local-precedence preference **after** both OAuth clients are persisted.
Signing in or connecting with unchanged OAuth fields leaves deployment precedence
intact. Storage failures are surfaced in the panel and prevent a success toast or
authorization; a failed write also leaves that manager’s in-memory state unchanged. This preserves OIDC and Google Drive
configuration on automatic startup. Failed validation does not change precedence.
Explicit config imports still apply immediately, and
`app.enableConfigOverridesOnLoad()` restores deployment precedence. This uses the
existing configuration policy rather than special-casing the `email` scope.

The preference also preserves an existing Drive runtime base URL, as defined by
the existing policy; agent and runner configuration retain their existing rules.
Settings are local to this browser and origin. Previously overwritten values
cannot be recovered automatically: re-enter and save them after the fix arrives.

## Regression evidence

`app/test/browser/test-scenario-authentication-settings.ts` forces production
precedence before interacting with the real settings UI. It checks two reloads,
compares the visible scope field with the OIDC runtime, and verifies that explicit
restoration of deployment defaults still works. It records a screenshot and movie,
and restores its original storage keys without writing credentials to artifacts.

Component and manager tests cover successful saves, unchanged and edited sign-ins,
validation failures, and storage failures followed by a successful retry. The startup test recreates
singleton managers from storage and invokes the actual async YAML preload.
