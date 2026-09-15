# Runme OAuth flow and diagnostics

## Journey and automated evidence

`app/test/browser/test-scenario-oidc-login.ts` uses an isolated Chromium profile
and the shared Go OIDC fixture (`testing/cuj-oidc-server.go`). For each combination
of PKCE/implicit and popup/new-tab/redirect, it saves the UI options, reloads,
opens diagnostics while signed out, signs in through the real authorization and
callback routes, verifies the original tab's identity and actual interaction,
and signs out again. Each combination records a screenshot and video in
`app/test/browser/test-output/`. The fixture performs a one-use authorization
code exchange that validates S256 PKCE, or signs an implicit response with a
nonce and access-token hash. No real identity or provider credential is used.

## Critical design decisions

- Runme and Drive flow settings are independent. An omitted Runme flow preserves
  legacy automatic selection; an explicit flow is never silently substituted.
  Saving unchanged defaults must not accidentally pin deployment configuration.
- Only the initiating tab validates and installs credentials. Popup/new-tab
  callbacks relay to that tab and are accepted only from the exact child window
  on the callback origin/path; protocol state and nonce still require validation.
  No raw credentials are sent to an arbitrary opener or logged by the transport.
- Open the child synchronously before discovery to retain browser user activation.
  Blocked windows, cancellation, provider failure, and timeout fail visibly.
  If an opener is unavailable, users can choose same-page redirect.
- PKCE and implicit transactions are tab-local. A new login invalidates earlier
  asynchronous work before it can overwrite transaction state or install tokens.
  Changing settings mid-login fails closed. Fresh login replaces old credentials;
  refresh preserves a refresh token only within the existing session.
- Generic implicit responses require RS256 verification against discovered keys,
  exact issuer/audience and nonce checks, bounded age, and at_hash verification.
  Google keeps its known issuer aliases and keys. Unsupported provider response
  types produce an actionable error recommending PKCE.
- Diagnostics projects an allowlist of claims and never renders raw tokens,
  secrets, or arbitrary claim objects. It handles absent/malformed claims and
  unknown expiry. Its timer updates expiry without initiating auth or refresh.
  Recorded session flow and next-login configuration are separate fields.

## Additional regressions

Unit/component tests cover signed implicit validation, window-origin and source
isolation, duplicate responses, denial/cancellation/timeouts, a cancelled login
finishing discovery late, persisted choices, independence from Drive, right-click
without auth mutation, malformed claims, expiry transitions and logout updates.
