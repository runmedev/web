# Configuration Architecture

## Goal

Client configuration should be runtime-driven so the same built PWA can run in different environments (dev/test/prod) without rebuilding.

## Runtime Configuration Pattern

1. Server hosts a YAML file at a well-known path, for example:
   - `/configs/app-config.yaml`
2. On startup, the client configuration loader fetches this file.
3. The app initializes default settings from that runtime config.
4. Optional local overrides (for example localStorage or App Console setters) are applied on top.

This avoids hard-coding environment behavior into build-time `VITE_*` values for features that should vary per deployment.

## Suggested Precedence

1. Explicit runtime/user override (App Console or localStorage)
2. Server-provided runtime config (`/configs/app-config.yaml`)
3. Build-time defaults (`import.meta.env`) as fallback only

## Deprecated Bootstrap State

`window.__INITIAL_STATE__` is deprecated for new configuration work and should
not be used going forward.

- Existing code paths may still read it for backward compatibility.
- New configuration should be added to runtime YAML config instead.

## Testing and Fake Services

For integration testing, serve an app config that points the client at test doubles (for example fake Google Drive server). This keeps test setup declarative and close to production configuration behavior.

Example (illustrative):

```yaml
oidc:
  clientExchange: true
  generic:
    clientID: "<oidc-client-id>"
    clientSecret: ""
    discoveryURL: "https://accounts.example.com/.well-known/openid-configuration"
    scopes:
      - "openid"
      - "email"
googleDrive:
  clientID: "<google-drive-client-id>"
  clientSecret: ""
  baseUrl: "http://127.0.0.1:9090"
```

## Vite Dev Server Support

Yes, this works with Vite.

- Option 1: place `configs/app-config.yaml` under Vite public assets so it is served at `/configs/app-config.yaml`.
- Option 2: use a Vite proxy/rewrite to route `/configs/app-config.yaml` to an external config source.
- Option 3: swap config files per test run (for example by copying a test fixture into the served public path before launching dev server).

The key point is that the client reads config at runtime from HTTP, so dev/test can switch behavior without changing the bundle.

## Typed Schema

Define a TypeScript schema for runtime config so loaders and consumers share one contract:

- `app/src/config/appConfig.ts`

This module defines:

- `RuntimeAppConfig` interface for the normalized config shape (concrete defaults, no optional fields).
- `RuntimeAppConfigSchema.fromUnknown(...)` for normalizing untyped parsed YAML.
- OIDC and Google Drive config blocks (including key normalization such as `clientID` and `discoveryURL`).
- Empty-string sentinel for unset string values.
- Drive base URL field; upload endpoint derivation and fallback behavior are handled by Drive client initialization code.
