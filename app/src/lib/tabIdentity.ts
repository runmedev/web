import { v4 as uuidv4 } from "uuid";

export const SESSION_QUERY_PARAM = "session";
const SESSION_STORAGE_KEY = "runme/sessionId";
const STALE_RESTORE_CACHE_KEY = "runme/staleSessionRestoreCache";

let sessionId: string | null = null;
let claimedSessionId: string | null = null;
let claimPromise: Promise<string> | null = null;
let releaseSessionLock: (() => void) | null = null;
let releaseListenerRegistered = false;
let sessionLockHeld = false;

// Keep the word lists local instead of depending on unique-names-generator.
// That package is a good fit functionally, but adding it caused long registry
// proxy stalls in this workspace for a small runtime need. A UUID suffix
// prevents accidental reuse of an older durable session.
const SESSION_PREFIXES = [
  "amber",
  "blue",
  "brave",
  "bright",
  "calm",
  "clear",
  "cool",
  "crisp",
  "fast",
  "fresh",
  "gold",
  "green",
  "kind",
  "lucky",
  "quiet",
  "quick",
  "red",
  "sharp",
  "silver",
  "smart",
  "steady",
  "swift",
  "warm",
  "wise",
];

const SESSION_NOUNS = [
  "anchor",
  "beacon",
  "brook",
  "cedar",
  "cloud",
  "comet",
  "copper",
  "delta",
  "ember",
  "field",
  "forge",
  "harbor",
  "island",
  "lantern",
  "maple",
  "meadow",
  "mesa",
  "orbit",
  "pebble",
  "pine",
  "quartz",
  "river",
  "signal",
  "stone",
  "summit",
  "thunder",
  "valley",
  "willow",
  "wind",
  "zephyr",
];

function randomIndex(maxExclusive: number): number {
  if (maxExclusive <= 0) {
    return 0;
  }

  const crypto = globalThis.crypto;
  if (crypto?.getRandomValues) {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return values[0] % maxExclusive;
  }

  return Math.floor(Math.random() * maxExclusive);
}

export function createSessionId(): string {
  return (
    [
      SESSION_PREFIXES[randomIndex(SESSION_PREFIXES.length)],
      SESSION_NOUNS[randomIndex(SESSION_NOUNS.length)],
    ].join("-") +
    "-" +
    (globalThis.crypto?.randomUUID?.() ?? uuidv4())
  );
}

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readStoredSessionId(): string | null {
  const storage = getSessionStorage();
  if (!storage) {
    return null;
  }

  try {
    return storage.getItem(SESSION_STORAGE_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

function writeStoredSessionId(id: string): void {
  const storage = getSessionStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(SESSION_STORAGE_KEY, id);
  } catch {
    // Session identity still works in memory when storage is unavailable.
  }
}

function initializeSessionId(): string {
  const stored = readStoredSessionId();
  if (stored) {
    return stored;
  }

  // The URL is a restore hint only. No durable state is read before its lock
  // is acquired. Keep existing tab-local identity first for OAuth callbacks.
  const requested =
    typeof window === "undefined"
      ? null
      : new URL(window.location.href).searchParams.get(SESSION_QUERY_PARAM);
  const created =
    requested && /^[a-zA-Z0-9_-]{1,100}$/.test(requested) && hasWebLocks()
      ? requested
      : createSessionId();
  writeStoredSessionId(created);
  return created;
}

function hasWebLocks(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.locks?.request === "function"
  );
}

export function buildSessionLockName(id: string): string {
  return `runme:session:${id}`;
}

/** Short gate prevents GC's temporary owner lock from looking like a live tab. */
export function buildSessionClaimLockName(id: string): string {
  return `runme:session-claim:${id}`;
}

function updateSessionQueryParam(id: string): void {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  if (url.searchParams.get(SESSION_QUERY_PARAM) === id) {
    return;
  }

  url.searchParams.set(SESSION_QUERY_PARAM, id);
  window.history.replaceState(
    null,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

/** Disable writes before releasing ownership. BFCache resumes must claim anew. */
function releaseOnPageHide(): void {
  sessionLockHeld = false;
  releaseSessionLock?.();
  releaseSessionLock = null;
}

function reloadOnPageShow(event: PageTransitionEvent): void {
  if (!event.persisted) return;
  markSessionRestoreCacheStale();
  window.location.reload();
}

function registerSessionLockRelease(): void {
  if (releaseListenerRegistered || typeof window === "undefined") return;
  releaseListenerRegistered = true;
  window.addEventListener("pagehide", releaseOnPageHide);
  window.addEventListener("pageshow", reloadOnPageShow);
}

/** Durable state is writable only while this document holds the session lock. */
export function hasSessionLock(): boolean {
  return sessionLockHeld;
}

/**
 * BFCache relinquishes ownership. Remember across reload that another owner may
 * have updated the durable record; do not discard fallback state until a valid
 * record has been read under the newly acquired lock.
 */
export function markSessionRestoreCacheStale(): void {
  try {
    getSessionStorage()?.setItem(STALE_RESTORE_CACHE_KEY, "1");
  } catch {
    // Unavailable sessionStorage has no readable restore cache to invalidate.
  }
}

/** Consume the one-reload hint; ordinary reloads still prefer tab-local state. */
export function consumeStaleSessionRestoreCache(): boolean {
  try {
    const storage = getSessionStorage();
    const stale = storage?.getItem(STALE_RESTORE_CACHE_KEY) === "1";
    storage?.removeItem(STALE_RESTORE_CACHE_KEY);
    return stale;
  } catch {
    return false;
  }
}

/** Clear every notebook restore hint after a fork or stale-cache recovery. */
export function clearSessionRestoreState(): void {
  try {
    const storage = getSessionStorage();
    storage?.removeItem("runme/openNotebooks");
    storage?.removeItem("runme/currentDoc");
    // The workspace controller also caches notebook tabs independently.
    storage?.removeItem("runme/workspaceDocuments");
  } catch {
    /* Tab-local persistence may be disabled. */
  }
}

async function tryClaimSessionId(id: string): Promise<boolean> {
  if (!hasWebLocks()) {
    return true;
  }

  try {
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (claimed: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(claimed);
      };

      void navigator.locks
        .request(
          buildSessionLockName(id),
          { ifAvailable: true },
          async (lock) => {
            if (!lock) {
              settle(false);
              return;
            }

            sessionLockHeld = true;
            registerSessionLockRelease();
            const released = new Promise<void>((release) => {
              releaseSessionLock = release;
            });
            settle(true);
            await released;
          },
        )
        .catch(() => settle(false));
    });
  } catch {
    return false;
  }
}

async function claimSessionId(): Promise<string> {
  const seen = new Set<string>();
  const maxAttempts = 8;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = attempt === 0 ? getSessionId() : createSessionId();
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    // Serialize the claim with GC for this ID, without waiting for a live
    // owner's lifetime lock. Only the short claim/delete decision holds this gate.
    const claimed = hasWebLocks()
      ? await Promise.resolve()
          .then(() =>
            navigator.locks.request(
              buildSessionClaimLockName(candidate),
              {},
              () => tryClaimSessionId(candidate),
            ),
          )
          .catch(() => false)
      : await tryClaimSessionId(candidate);
    if (claimed) {
      if (candidate !== sessionId) clearSessionRestoreState();
      sessionId = candidate;
      claimedSessionId = candidate;
      writeStoredSessionId(candidate);
      updateSessionQueryParam(candidate);
      return candidate;
    }
  }

  // Lock errors never authorize durable reads/writes or reuse of another tab.
  clearSessionRestoreState();
  sessionId = createSessionId();
  claimedSessionId = sessionId;
  writeStoredSessionId(claimedSessionId);
  updateSessionQueryParam(claimedSessionId);
  return claimedSessionId;
}

/**
 * getSessionId returns the Runme browser session identifier for this page.
 *
 * The id is restored from sessionStorage, then the URL after an app restart.
 * Newly allocated IDs include a UUID so old durable records are never reused
 * by chance. Browser tab duplication may copy both the URL and
 * sessionStorage, so Web Locks remain the ownership authority and force a new
 * persisted id when another live tab already owns the stored one.
 */
export function getSessionId(): string {
  if (!sessionId) {
    sessionId = initializeSessionId();
  }
  return sessionId;
}

export function getClaimedSessionId(): Promise<string> {
  if (claimedSessionId) {
    return Promise.resolve(claimedSessionId);
  }
  if (!claimPromise) {
    claimPromise = claimSessionId();
  }
  return claimPromise;
}

/**
 * Backwards-compatible name for ownership code that still talks in tab IDs.
 */
export function getTabId(): string {
  return getSessionId();
}

export function ensureSessionQueryParam(): string {
  const id = getSessionId();
  updateSessionQueryParam(id);
  void getClaimedSessionId();
  return id;
}

export function __resetTabIdForTests(): void {
  releaseOnPageHide();
  window.removeEventListener("pagehide", releaseOnPageHide);
  window.removeEventListener("pageshow", reloadOnPageShow);
  sessionId = null;
  claimedSessionId = null;
  claimPromise = null;
  releaseSessionLock = null;
  releaseListenerRegistered = false;
}
