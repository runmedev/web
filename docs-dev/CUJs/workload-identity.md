# Unattended Drive authentication through a Runme runner

Use a dedicated browser profile with no human credentials. Provision an ES256
test key, a runner with static JWT auth and explicit role bindings, and a Google
token-broker fixture. Use Go fixtures for backend behavior. Configure trusted
HTTPS for a real runner; do not disable browser certificate verification.

1. Inspect WebMCP schemas and invoke `configureRunnerAuth` with `--params @file`.
   Assert status contains the stable subject `runme` and no key/token bytes.
2. Invoke `configureGoogleWorkloadIdentity` with the expected GSA and Drive scope.
   Assert the fixture receives that scope/lifetime and a verifiable runner JWT.
3. Make simultaneous requests. Assert they share the same runner JWT and one
   Google mint. Force credential renewal and verify returned account/scopes.
4. Clear runner auth. Assert subsequent requests fail without human OAuth or a
   cookie/query-auth fallback. Reimport the key and confirm recovery.
5. Reload. Assert the nonsecret mode survives but signing needs provisioning.
   Reimport the same key without creating any session identity.
6. Verify wrong key, wrong audience, forbidden scope, and wrong returned GSA
   fail. Changing identity while a request is pending must discard its result.
7. Connect a second tab using a different credential mode. Assert the storage
   owner rejects mixing identities and never borrows another tab's token.
8. For the deployment smoke, create/edit/reopen a notebook in a dedicated Shared
   drive and repeat after real Google token expiry. Record effective GSA and
   redacted status; never record input private keys or raw credentials.

Unit/integration coverage: `auth/runnerAuth.test.ts`, GoogleAuthContext and
WebMCP registration tests, storage owner message-boundary tests, and the runner's
static verifier, credential policy/coalescing, IAM request, and HTTP tests.
The real GKE/Drive smoke requires deployment credentials and is a release gate.
