import { Button, ScrollArea, Text } from "@radix-ui/themes";

import {
  driveLinkCoordinator,
  useDriveLinkCoordinatorSnapshot,
} from "../lib/driveLinkCoordinator";

function identityLabel(identity: {
  displayName?: string;
  emailAddress?: string;
}): string {
  if (identity.displayName && identity.emailAddress) {
    return `${identity.displayName} (${identity.emailAddress})`;
  }
  return identity.emailAddress ?? identity.displayName ?? "Unknown owner";
}

export function DriveLinkStatusTab({
  onLogin,
  onRetry,
}: {
  onLogin: () => void | Promise<void>;
  onRetry: () => void | Promise<void>;
}) {
  const snapshot = useDriveLinkCoordinatorSnapshot();
  const awaitingReview = snapshot.intents.filter(
    (intent) => intent.status === "awaiting_review",
  );

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
            {awaitingReview.length > 0
              ? "Review Shared Notebook"
              : "Loading Shared Notebook"}
          </Text>
          <Text size="2" as="p" className="text-nb-text-muted">
            {awaitingReview.length > 0
              ? "Runme has only read Google Drive metadata. Notebook content will not be downloaded or rendered until you trust it."
              : "The app is resolving one or more shared Google Drive links."}
          </Text>
        </div>

        <div className="rounded-lg border border-nb-border bg-nb-surface-2 p-4">
          <Text size="3" weight="bold" as="p" className="text-nb-text">
            Status
          </Text>
          <Text
            size="2"
            as="p"
            className={
              snapshot.authBlocked
                ? "mt-2 text-nb-error"
                : "mt-2 text-nb-text-muted"
            }
          >
            {snapshot.authBlocked
              ? "Google Drive authorization is required before shared links can be loaded. Click Login to Drive to continue."
              : awaitingReview.length > 0
                ? "One or more notebooks are from an owner Runme could not automatically trust. Review the source before opening."
                : snapshot.intents.length === 0 && snapshot.lastErrorMessage
                  ? "No pending shared links. See the latest status message below."
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
          <div className="mt-4 flex flex-wrap gap-3">
            {snapshot.authBlocked && (
              <Button onClick={() => void onLogin()}>Login To Drive</Button>
            )}
            <Button variant="soft" onClick={() => void onRetry()}>
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
                  {intent.preflight ? (
                    <div className="mt-2 space-y-1 text-sm text-nb-text">
                      <div>
                        <span className="font-semibold">Name:</span>{" "}
                        {intent.preflight.name}
                      </div>
                      <div>
                        <span className="font-semibold">Owner:</span>{" "}
                        {intent.preflight.owners.length > 0
                          ? intent.preflight.owners
                              .map(identityLabel)
                              .join(", ")
                          : "Google Drive did not provide owner information"}
                      </div>
                      <div>
                        <span className="font-semibold">Location:</span>{" "}
                        {intent.preflight.parents.length > 0
                          ? intent.preflight.parents
                              .map((parent) => parent.name)
                              .join(", ")
                          : "No parent folder reported"}
                      </div>
                      {intent.preflight.lastModifyingUser && (
                        <div>
                          <span className="font-semibold">
                            Last modified by:
                          </span>{" "}
                          {identityLabel(intent.preflight.lastModifyingUser)}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="mt-1 break-all text-sm text-nb-text">
                      {intent.remoteUri}
                    </div>
                  )}
                  <div className="mt-1 text-xs text-nb-text-muted">
                    action={intent.action} retries={intent.retryCount}
                  </div>
                  {intent.lastErrorMessage && (
                    <div className="mt-2 text-xs text-nb-error">
                      {intent.lastErrorMessage}
                    </div>
                  )}
                  {intent.status === "awaiting_review" && (
                    <div className="mt-3 space-y-3">
                      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
                        Opening a notebook can display active content and may
                        expose data available to this browser session. Only
                        continue if you recognize and trust its source.
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          data-testid="drive-link-trust-open"
                          onClick={() =>
                            void driveLinkCoordinator.trustAndOpen(intent.id)
                          }
                        >
                          Trust This Document And Open
                        </Button>
                        <Button
                          variant="soft"
                          data-testid="drive-link-cancel"
                          onClick={() =>
                            driveLinkCoordinator.cancelIntent(intent.id)
                          }
                        >
                          Cancel
                        </Button>
                        <a
                          className="inline-flex items-center text-xs text-blue-700 underline"
                          href={intent.remoteUri}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open In Google Drive
                        </a>
                      </div>
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
