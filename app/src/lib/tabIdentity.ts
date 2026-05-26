let tabId: string | null = null;

/**
 * getTabId returns a per-page-load browser tab identifier.
 *
 * The id is intentionally in memory only. `sessionStorage` survives reloads and
 * may be cloned when a browser tab is duplicated, so it is useful for restoring
 * UI state but not for proving tab identity. Web Locks remain the ownership
 * authority; this id is only metadata for diagnostics and blocked-state UI.
 */
export function getTabId(): string {
  if (!tabId) {
    tabId = crypto.randomUUID();
  }
  return tabId;
}

export function __resetTabIdForTests(): void {
  tabId = null;
}
