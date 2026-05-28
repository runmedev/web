export const SESSION_QUERY_PARAM = "session";

let sessionId: string | null = null;
let claimedSessionId: string | null = null;
let claimPromise: Promise<string> | null = null;
let releaseSessionLock: (() => void) | null = null;
let releaseListenerRegistered = false;

// Keep the word lists local instead of depending on unique-names-generator.
// That package is a good fit functionally, but adding it caused long registry
// proxy stalls in this workspace for a small runtime need. Web Locks are used
// below to avoid live-tab collisions, so these lists do not need to be huge.
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

function createSessionId(): string {
  return [
    SESSION_PREFIXES[randomIndex(SESSION_PREFIXES.length)],
    SESSION_NOUNS[randomIndex(SESSION_NOUNS.length)],
  ].join("-");
}

function hasWebLocks(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.locks?.request === "function"
  );
}

function buildSessionLockName(id: string): string {
  return `runme:session:${id}`;
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

function registerSessionLockRelease(): void {
  if (releaseListenerRegistered || typeof window === "undefined") {
    return;
  }
  releaseListenerRegistered = true;
  window.addEventListener("pagehide", () => {
    releaseSessionLock?.();
    releaseSessionLock = null;
  });
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
    return true;
  }
}

async function claimSessionId(): Promise<string> {
  const seen = new Set<string>();
  const maxAttempts = SESSION_PREFIXES.length * SESSION_NOUNS.length;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = attempt === 0 ? getSessionId() : createSessionId();
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    if (await tryClaimSessionId(candidate)) {
      sessionId = candidate;
      claimedSessionId = candidate;
      updateSessionQueryParam(candidate);
      return candidate;
    }
  }

  // If every readable name is actively locked, fall back to the current
  // candidate so the app still has a stable session label.
  claimedSessionId = getSessionId();
  updateSessionQueryParam(claimedSessionId);
  return claimedSessionId;
}

/**
 * getSessionId returns the Runme browser session identifier for this page.
 *
 * The id is intentionally in memory only and generated per page load. Browser
 * tab duplication copies the URL and may copy sessionStorage, so neither is a
 * reliable source of tab identity. Web Locks remain the ownership authority for
 * editable notebook state; this id is metadata for Codex/browser-tab routing
 * and blocked-state UI.
 */
export function getSessionId(): string {
  if (!sessionId) {
    sessionId = createSessionId();
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
  releaseSessionLock?.();
  sessionId = null;
  claimedSessionId = null;
  claimPromise = null;
  releaseSessionLock = null;
  releaseListenerRegistered = false;
}
