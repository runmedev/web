function getShareBaseUrl(): URL {
  if (typeof window === "undefined") {
    throw new Error("Share links are only available in a browser environment");
  }

  return new URL(window.location.pathname, window.location.origin);
}

function getNotebookLinkText(name: string): string {
  const trimmed = name.trim();
  const withoutJson = trimmed.replace(/\.json$/i, "");
  return withoutJson || trimmed || "Untitled";
}

function escapeMarkdownLinkText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
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

export function buildNotebookMarkdownLink(
  name: string,
  remoteUri: string,
): string {
  const linkText = escapeMarkdownLinkText(getNotebookLinkText(name));
  return `[${linkText}](${buildNotebookShareUrl(remoteUri)})`;
}

export async function copyNotebookShareUrl(remoteUri: string): Promise<string> {
  if (typeof window === "undefined" || !window.navigator?.clipboard?.writeText) {
    throw new Error("Clipboard access is unavailable in this browser");
  }

  const shareUrl = buildNotebookShareUrl(remoteUri);
  await window.navigator.clipboard.writeText(shareUrl);
  return shareUrl;
}

export async function copyNotebookMarkdownLink(
  name: string,
  remoteUri: string,
): Promise<string> {
  if (typeof window === "undefined" || !window.navigator?.clipboard?.writeText) {
    throw new Error("Clipboard access is unavailable in this browser");
  }

  const markdownLink = buildNotebookMarkdownLink(name, remoteUri);
  await window.navigator.clipboard.writeText(markdownLink);
  return markdownLink;
}
