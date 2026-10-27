# Independent launcher updates

The application and storage owner remain pinned to the selected release until a
coordinated transition completes. The launcher is infrastructure: each new page
checks `/launcher.json` for the latest backwards-compatible launcher, independent
of stable/latest/pinned application selection. Existing pages keep their running
launcher until normal navigation or coordinated reload.

A small bootstrap is embedded in every new release shell. It does not read
IndexedDB, acquire storage ownership, or change release selection. The publisher
updates `launcher.json` only after immutable assets and release acceptance pass,
using the same stale-source and generation checks as root publication. Pinning
stable does not pin the launcher. Descriptor protocol 1 is permanent; a future
incompatible descriptor is rejected rather than interpreted optimistically.

The bootstrap gives the online check, module verification, and caching four
seconds total. On failure it allows one second for a previously verified cached
launcher; if unavailable, it loads the shell's bundled launcher, which the
service worker precaches with its static dependencies. It verifies hashes before
recording a completed launcher snapshot. It never executes two launchers in the
same document. Module execution failure shows an explicit retry instead of
risking overlapping coordination loops. No notebook data is removed.

The active service worker may still serve an older shell. Once that shell has
this bootstrap, it can select the latest launcher without waiting for a new
service worker to activate. No skipWaiting, forced worker termination, or lock
stealing is used. This bootstrap cannot retroactively modify a historical shell.
For a pre-bootstrap installation, open the newly published immutable
`/version/<release-id>/launcher.html` on the same origin. Historical workers pass
that navigation through; the new bootstrap can run alongside older open tabs
while still starting their selected app release. After the old windows close,
the waiting service worker can activate normally. The root `/recovery.html` is
not sufficient for that first migration because historical workers intercept it.

Diagnostics record the bootstrap's bundled release, selection source, selected
launcher release, and lookup failure. Launcher startup diagnostics also record
the executing script path and selection source. The startup panel exposes retry
before release settings can be read. Existing bounded IndexedDB recovery and
admission rules still apply; a timeout never proves another writer is absent.

Tests cover incompatible descriptors, invalid paths, incomplete/corrupt caches,
network and CacheStorage hangs, offline fallback, and publication with pinned
stable. The controlled-release browser suite asserts launcher B with app/owner A
while A tabs remain open, then exercises coordinated upgrade, durable edits,
offline restart, rollback, and damaged release settings. CI also builds the frozen pre-bootstrap commit
`9a5fdbf0ca30bf73431b7c4eb90f75f3c91e3ecf` with its own lockfile and runs the same
suite, entering through the explicit migration URL while older tabs remain open.
Historical launcher protocol changes must extend this matrix before publication.
