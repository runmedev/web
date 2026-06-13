# Google Drive Service Account Auth

## Status

Implemented for local and automated testing.

## Motivation

Automated browser tests need Google Drive access without a human OAuth consent
flow. A Google Cloud service account can be granted access only to test Drive
folders, which limits the blast radius compared with using a developer's
personal Google account.

## Verification

Google supports service-account OAuth for server-to-server calls. The service
account signs a JWT assertion with its private key, exchanges that assertion at
Google's OAuth token endpoint, and uses the returned access token as a bearer
token for Google APIs:

- https://developers.google.com/identity/protocols/oauth2/service-account

Google Drive access still follows Drive ACLs. Files, folders, and shared drives
have permission resources, and the authenticated principal only gets the roles
granted to that principal or inherited from a parent:

- https://developers.google.com/workspace/drive/api/guides/manage-sharing
- https://developers.google.com/drive/api/guides/about-files

That means a service account works for Drive when one of these is true:

- the target My Drive folder/file is shared with the service account email,
- the target shared drive grants the service account membership or folder
  access,
- or a Google Workspace admin grants domain-wide delegation and the JWT includes
  a delegated user subject.

For test isolation, the preferred model is to create a dedicated folder or shared
drive for test fixtures and share only that location with the service account.

## Decision

Add a third Google Drive auth flow:

```yaml
googleDrive:
  authFlow: "service_account"
  serviceAccount:
    client_email: "runme-drive-test@project.iam.gserviceaccount.com"
    private_key_id: "..."
    private_key: |
      -----BEGIN PRIVATE KEY-----
      ...
      -----END PRIVATE KEY-----
```

The browser app mints short-lived OAuth access tokens from the service-account
credentials using Web Crypto and Google's JWT bearer grant. The existing
`DriveNotebookStore` does not change because it already only needs a bearer
token callback.

For manual local setup, the App Console exposes:

```js
await credentials.google.setServiceAccountFromFile()
await credentials.google.setServiceAccountFromFilePath(
  "/Users/jlewi/secrets/aisre-gdrive-oai-test-8ba1a40f228e.json"
)
```

`setServiceAccountFromFile()` opens a browser file picker, reads a local
service-account JSON key file, and applies it through the same parser used by
app config.

`setServiceAccountFromFilePath(path)` is only available behind the local Vite
dev server. It asks the dev server to read an absolute `.json` path because
browser JavaScript cannot read arbitrary local paths by itself.

This is not a production browser-auth recommendation. Supplying a private key to
browser JavaScript exposes that key to anyone who can read the page, local
storage, config response, devtools, or test logs. The supported use case is
local/CI test automation with a tightly scoped service account and disposable
test Drive resources. A production deployment should mint the access token on a
trusted server and send only the short-lived token to the browser.

## Token Flow

1. Runtime config selects `googleDrive.authFlow: service_account`.
2. `GoogleAuthProvider.ensureAccessToken()` checks the cached access token.
3. If no valid token exists, the provider builds a JWT:
   - header: `alg=RS256`, `typ=JWT`, optional `kid`,
   - claims: `iss`, `scope`, `aud`, `iat`, `exp`, optional `sub`,
   - signature: RSA SHA-256 over the base64url header and claims.
4. The provider POSTs the assertion to `token_uri` or
   `https://oauth2.googleapis.com/token`.
5. The returned access token is cached with the same expiry handling as normal
   Drive OAuth tokens.
6. Existing Drive REST/gapi clients use the bearer token unchanged.

## Scope And Permissions

By default the flow uses the app's current Drive scopes:

- `https://www.googleapis.com/auth/drive`
- `https://www.googleapis.com/auth/drive.install`

Tests can override scopes:

```yaml
googleDrive:
  authFlow: "service_account"
  serviceAccount:
    client_email: "runme-drive-test@project.iam.gserviceaccount.com"
    private_key: |
      -----BEGIN PRIVATE KEY-----
      ...
      -----END PRIVATE KEY-----
    scopes:
      - "https://www.googleapis.com/auth/drive.readonly"
```

For domain-wide delegation, set `subject` to the user being impersonated:

```yaml
googleDrive:
  authFlow: "service_account"
  serviceAccount:
    client_email: "runme-drive-test@project.iam.gserviceaccount.com"
    private_key: |
      -----BEGIN PRIVATE KEY-----
      ...
      -----END PRIVATE KEY-----
    subject: "test-user@example.com"
```

## Alternatives Considered

### Put private keys into the existing OAuth client secret field

Rejected. OAuth client secrets and service-account private keys represent
different credential types and need different token grants. Overloading the
field would make config validation and troubleshooting unclear.

### Require a backend token broker first

Deferred. A broker is the right production shape, but local browser tests can
move now with a clearly test-only service-account flow. The Drive store boundary
still accepts a token callback, so a broker can be added later without changing
Drive operations.

### Use signed JWT directly as the Drive bearer token

Rejected for this implementation. Google's service-account docs say some Google
APIs support direct JWT bearer calls, but the standard and broadly compatible
path is to exchange the JWT for an OAuth access token first.

## Test Plan

- Unit-test JWT construction from a generated RSA key.
- Unit-test JWT bearer token exchange request shape.
- Unit-test app-config parsing for `authFlow: service_account`.
- Unit-test `GoogleAuthProvider.ensureAccessToken({ interactive: false })` so it
  mints a service-account token without opening OAuth UI.
- Run `runme run build test` before merging.
