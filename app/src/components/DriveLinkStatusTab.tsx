import { Button, ScrollArea, Text } from "@radix-ui/themes";

import { useDriveLinkCoordinatorSnapshot } from "../lib/driveLinkCoordinator";

export function DriveLinkStatusTab({
  onRetry,
}: {
  onRetry: () => void | Promise<void>;
}) {
  const snapshot = useDriveLinkCoordinatorSnapshot();

  return (
    <ScrollArea
      type="auto"
      scrollbars="vertical"
      className="flex-1 p-4"
      data-testid="drive-link-status-scroll"
    >
      <div className="mx-auto flex h-full max-w-3xl flex-col gap-6 text-sm">
        <div className="space-y-2">
          <Text size="5" weight="bold" as="p" className="text-nb-text">
            Loading Shared Notebook
          </Text>
          <Text size="2" as="p" className="text-nb-text-muted">
            The app is resolving one or more shared Google Drive links.
          </Text>
        </div>

        <div className="rounded-lg border border-nb-border bg-nb-surface-2 p-4">
          <Text size="3" weight="bold" as="p" className="text-nb-text">
            Status
          </Text>
          <Text
            size="2"
            as="p"
            className={snapshot.authBlocked ? "mt-2 text-nb-error" : "mt-2 text-nb-text-muted"}
          >
            {snapshot.authBlocked
              ? "Google Drive authorization is required before shared links can be loaded. If loading does not continue, make sure your browser is not blocking popups needed for the Google Drive auth flow."
              : "Shared links are queued for processing."}
          </Text>
          {snapshot.lastErrorMessage && (
            <pre
              className="mt-3 whitespace-pre-wrap rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-900"
              data-testid="drive-link-status-error"
            >
              {snapshot.lastErrorMessage}
            </pre>
          )}
          <div className="mt-4">
            <Button onClick={() => void onRetry()}>
              Retry Loading Shared Links
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-nb-border bg-white p-4">
          <Text size="3" weight="bold" as="p" className="text-nb-text">
            Pending URIs
          </Text>
          {snapshot.intents.length === 0 ? (
            <Text size="2" as="p" className="mt-2 text-nb-text-muted">
              No pending shared links.
            </Text>
          ) : (
            <ul className="mt-3 space-y-3" data-testid="drive-link-status-list">
              {snapshot.intents.map((intent) => (
                <li
                  key={intent.id}
                  className="rounded-md border border-nb-border bg-nb-surface p-3"
                >
                  <div className="text-xs font-semibold uppercase tracking-wide text-nb-text-faint">
                    {intent.status}
                  </div>
                  <div className="mt-1 break-all text-sm text-nb-text">
                    {intent.remoteUri}
                  </div>
                  <div className="mt-1 text-xs text-nb-text-muted">
                    action={intent.action} retries={intent.retryCount}
                  </div>
                  {intent.lastErrorMessage && (
                    <div className="mt-2 text-xs text-nb-error">
                      {intent.lastErrorMessage}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}

export default DriveLinkStatusTab;
