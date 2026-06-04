function getShareBaseUrl(): URL {
  if (typeof window === "undefined") {
    throw new Error("Share links are only available in a browser environment");
  }

  return new URL(window.location.pathname, window.location.origin);
}

export function buildNotebookShareUrl(remoteUri: string): string {
  const trimmed = remoteUri.trim();
  if (!trimmed) {
    throw new Error("A remote notebook URI is required to build a share link");
  }

  const url = getShareBaseUrl();
  url.searchParams.set("doc", trimmed);
  return url.toString();
}

export async function copyNotebookShareUrl(remoteUri: string): Promise<string> {
  if (typeof window === "undefined" || !window.navigator?.clipboard?.writeText) {
    throw new Error("Clipboard access is unavailable in this browser");
  }

  const shareUrl = buildNotebookShareUrl(remoteUri);
  await window.navigator.clipboard.writeText(shareUrl);
  return shareUrl;
}
