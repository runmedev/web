# Browser App Data Migrations

Date: 2026-04-09

Related:

- `docs-dev/design/20260408a_refactor_notebooks.md`
- https://github.com/runmedev/web/issues/157

## Summary

Introduce an app-level, versioned migration system for durable browser state.

Dexie `db.version(n).upgrade(...)` remains the right mechanism for simple
single-database schema changes. The app-level migrator handles coordinated
changes that span multiple browser stores, for example:

- `runme-local-notebooks` IndexedDB
- `runme-fs-workspaces` IndexedDB
- `runme/currentDoc` localStorage
- `runme/openNotebooks` localStorage
- `runme/workspace` localStorage

## Motivation

The notebook refactor needs to change the meaning and shape of persisted state:

- browser-only local notebook records should move from `remoteId = ""` to
  `remoteId = localUri`
- filesystem-backed open tabs should move from `fs://workspace/...` to
  mirrored `local://file/...` records
- `runme-fs-workspaces` should eventually disappear
- localStorage pointers to current/open/workspace items must remain coherent
  with the IndexedDB records

Dexie table migrations alone are not enough for this because they do not own
localStorage and do not coordinate across separate IndexedDB databases.

## Recommended Pattern

Use a forward-only migration runner with a dated app-data version.

```text
localStorage["runme/app-data-version"] = "20260409"
```

When browser durable data changes, add one named migration and bump the target
version.

Example sequence:

```text
unversioned -> 20260409 -> 20260415 -> 20260420
```

The runner applies each migration in order. Do not try to support arbitrary
"jump directly from old to latest" functions; composing small adjacent
migrations is easier to test and safer to debug.

## App Data vs Ephemeral Auth State

Migrate durable app state that users expect to keep.

Examples:

| Store | Key / DB | Migration owner |
| --- | --- | --- |
| Notebook mirror | `runme-local-notebooks` | app migrator + Dexie |
| Filesystem handles | `runme-fs-workspaces` | app migrator while it exists |
| Current notebook pointer | `runme/currentDoc` | app migrator |
| Open notebook list | `runme/openNotebooks` | app migrator |
| Workspace roots | `runme/workspace` | app migrator |
| Pending Drive-link intents | `runme/drive-link-intents` | app migrator when shape changes |
| Runners | `runme/runners`, `runme/defaultRunner` | key-local migration or app migrator |
| Harness config | `runme/harness` | key-local migration or app migrator |

Avoid app-level migrations for transient auth handshakes:

- OIDC / Google PKCE verifier, nonce, state
- OAuth callback errors in sessionStorage
- "return to" URL for an in-flight auth redirect

Tokens/config can have narrowly scoped migration logic, but the global app-data
runner should not block startup trying to repair an expired auth flow.

## Proposed API

Add a small migration module, for example:

```ts
const APP_DATA_VERSION_STORAGE_KEY = "runme/app-data-version";
const APP_DATA_TARGET_VERSION = "20260409";

interface AppDataMigration {
  from: string;
  to: string;
  name: string;
  run(ctx: AppDataMigrationContext): Promise<void>;
}

interface AppDataMigrationContext {
  localStorage: Storage;
  openLocalNotebooksDb(): Promise<LocalNotebooks>;
  openFsDatabase(): Promise<FsDatabase>;
  log: typeof appLogger;
}
```

Startup should call:

```ts
await runBrowserAppDataMigrations();
```

before creating React contexts that restore current/open notebooks.

## Version Semantics

Use dated versions (`YYYYMMDD` or `YYYYMMDD_suffix`) for app-data migrations.

Why dated strings:

- readable in logs and bug reports
- easy to compare with deploy / PR timelines
- avoids coupling app-data migrations to npm package versions
- avoids coupling app-data migrations to Dexie integer schema versions

Dexie versions remain per-database integer schema versions. They are not a
replacement for app-data version.

## Migration Ledger

Persist the latest fully completed version only after a migration succeeds.

Optionally persist a debug ledger:

```json
{
  "version": "20260409",
  "completed": [
    {
      "name": "20260409_backfill_local_notebook_remote_id",
      "startedAt": "2026-04-09T12:00:00.000Z",
      "completedAt": "2026-04-09T12:00:01.000Z"
    }
  ]
}
```

The primary correctness key can stay simple:

```text
runme/app-data-version
```

## Idempotency

Write migrations so they can safely run more than once.

Examples:

- if `remoteId` is already non-empty, keep it
- if a filesystem-backed record has already been mirrored, reuse that local URI
- if `runme/currentDoc` already points at a local mirror, keep it
- if a localStorage array contains both old and new entries, dedupe by canonical
  local URI

The version key prevents normal re-runs; idempotency protects users if a tab is
closed mid-migration or a developer manually reruns a migration while debugging.

## Backup / Recovery

Before destructive or lossy changes, write a small backup manifest.

Example:

```text
localStorage["runme/app-data-migration-backup/20260409"] = JSON.stringify(...)
```

For notebook contents, prefer preserving the original IndexedDB record until
the new mirror record has been written and verified.

Do not delete old databases in the same migration that first introduces new
records. Use a later cleanup migration after the new code path has shipped and
been exercised.

## Observability

Every migration should log:

- migration name
- from / to versions
- started / completed
- counts of records inspected / changed / skipped / failed
- recoverable per-record errors
- unrecoverable fatal error before the runner stops

Use `appLogger` with a migration-specific scope:

```text
scope: storage.migration
```

## Failure Behavior

Prefer fail-closed for destructive steps and fail-open for optional repair.

Examples:

- If current-doc pointer migration fails, log and clear/select a safe fallback;
  do not block app startup indefinitely.
- If local notebook record migration fails for one file, log the local URI and
  continue with other files if the table remains consistent.
- If a migration cannot prove that a filesystem file was mirrored, keep the
  old `fs://workspace/...` localStorage pointer and show reconnect/migration UI
  rather than deleting it.

## Common Migration Patterns

### 1. LocalStorage Key Rename

Current code already does this in several places by reading a new key, falling
back to a legacy key, writing the new key, and removing the old key.

That pattern is fine for isolated key renames. Use the app-level runner when a
key rename must be consistent with IndexedDB record changes.

### 2. Dexie Table Shape Migration

Use Dexie for table-local schema/index/data changes:

```ts
this.version(4)
  .stores({
    files: "&id, remoteId, lastRemoteChecksum, md5Checksum, name, lastSynced",
    folders: "&id, remoteId, name, lastSynced",
  })
  .upgrade(async (tx) => {
    await tx.table("files").toCollection().modify((file) => {
      if (!file.remoteId) {
        file.remoteId = file.id;
      }
    });
  });
```

### 3. Cross-Store Pointer Migration

Use the app-level runner.

Example target for #157:

1. Mirror an `fs://workspace/...` notebook into a new local file record.
2. Record the mapping:
   - old URI -> new `local://file/<id>`
3. Rewrite `runme/currentDoc`.
4. Rewrite `runme/openNotebooks`.
5. Rewrite `runme/workspace` if needed.
6. Persist app-data version only after all pointers are rewritten.

## Initial Migration Set

### Baseline: `20260409`

Introduce the migration runner and write the baseline version.

For current users, this migration can initially be a no-op:

```text
unversioned -> 20260409
```

It should log the inventory of known stores and set
`runme/app-data-version = "20260409"` after startup.

### Future: notebook-local-mirror migration

The notebook refactor should add a new version after the baseline.

Responsibilities:

- backfill empty `LocalFileRecord.remoteId` values to `id`
- mirror fs-backed open files into `runme-local-notebooks`
- rewrite current/open notebook localStorage pointers
- preserve or mark fs workspace records for reconnect
- only set a `file://...` `remoteId` when we actually have a canonical file URI;
  otherwise keep a handle-backed app URI / reconnect state until the user picks
  the filesystem location again
- leave `runme-fs-workspaces` intact until a later cleanup version

### Future: fs-workspace cleanup migration

Only after filesystem-backed notebooks no longer need the old DB:

- verify no open/workspace localStorage entry requires `fs://workspace/...`
- delete or ignore `runme-fs-workspaces`
- set the next app-data version

## Test Plan

- Unit-test each migration from fixture input stores.
- Unit-test every adjacent version step.
- Browser-test a profile with unversioned local-only notebook data.
- Browser-test a profile with Drive-backed notebook mirrors.
- Browser-test a profile with `fs://workspace/...` pointers.
- Browser-test an interrupted migration by throwing after the first write, then
  rerunning the migration runner.
- Verify migration logs include from/to/version/count metadata.

## Open Questions

- Should the migration runner block initial React render, or show a small
  "Updating browser data..." shell while migrations run?
- Do we need a human-facing recovery UI for failed migrations, or are
  appLogger + safe fallback enough for the first refactor?
- Should migration backups live in localStorage, IndexedDB, or both?
