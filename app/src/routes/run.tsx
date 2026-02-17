import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MouseEvent, ReactNode } from "react";
import { useLocation, useParams } from "react-router-dom";

import {
  Box,
  Button,
  Callout,
  Flex,
  Heading,
  Spinner,
  Text,
} from "@radix-ui/themes";

import type { Run } from "../protogen/oaiproto/aisre/runs_pb.js";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { RunmeContentWrapper } from "../layout";
import { useRun } from "../lib/useRun.js";
import { useWindowStickToBottom } from "../lib/useWindowStickToBottom.js";
import {
  CellKind,
  type Cell,
  type CellOutput,
  type CellOutputItem,
  type Notebook,
} from "../protogen/runme/parser/v1/parser_pb.js";
import { isRunDone } from "../lib/conditions.js";
import {
  LEGACY_ASSET_MIME,
  RUNME_ASSET_MIME,
  type AssetRef,
  getAssetProxyUrl,
} from "../lib/assetRef.js";
import { useBaseUrl } from "../lib/useAisreClient.js";
import {
  IOPUB_INCOMPLETE_METADATA_KEY,
  IOPUB_MIME_TYPE,
} from "../lib/ipykernel.js";

const POLL_INTERVAL_MS = 5e3;

type NotebookViewerHandle = {
  scrollToBottom: () => void;
};

type NotebookViewerProps = {
  notebook: Notebook;
  initialCellTarget?: string;
  cellScrollEnabled?: boolean;
};

export default function RunRoute() {
  const { runName: rawRunName = "" } = useParams<{ runName?: string }>();
  const { hash } = useLocation();
  const normalizedRunName = rawRunName.trim();
  const decodedCellTarget = useMemo(() => {
    if (!hash) {
      return "";
    }
    try {
      return decodeURIComponent(hash.slice(1));
    } catch (error) {
      console.warn("Unable to decode location hash", { hash, error });
      return hash.slice(1);
    }
  }, [hash]);

  const {
    data: run,
    isPending: isRunLoading,
    isFetching: isRunFetching,
    error: runError,
    refetch: refetchRun,
  } = useRun(normalizedRunName, {
    refetchInterval: (run) => {
      if (run && !isRunDone(run)) {
        // Poll until done
        return POLL_INTERVAL_MS;
      }
      // Run is done, no need to poll
      return false;
    },
  });

  // Keep the window pinned to bottom while the run is in progress,
  // but only if the user is already at the bottom.
  const hasCellTarget = decodedCellTarget !== "";
  const isRunComplete = Boolean(run && isRunDone(run));
  const cellScrollEnabled = !isRunLoading;

  useWindowStickToBottom([run], {
    enabled: Boolean(run && !isRunComplete && !hasCellTarget),
    behavior: "smooth",
  });

  const notebookViewerRef = useRef<NotebookViewerHandle | null>(null);

  const handleRefresh = useCallback(() => {
    void refetchRun();
  }, [refetchRun]);

  const handleScrollToBottom = useCallback(() => {
    notebookViewerRef.current?.scrollToBottom();
  }, [notebookViewerRef]);

  const isLoading = isRunLoading;

  const pageContent = useMemo(() => {
    if (normalizedRunName === "") {
      return (
        <Callout.Root color="yellow">
          <Callout.Text className="font-medium">
            Provide a run name to view its notebook.
          </Callout.Text>
        </Callout.Root>
      );
    }

    if (isLoading) {
      return (
        <Flex
          align="center"
          className="h-full min-h-[200px] w-full"
          direction="column"
          gap="3"
          justify="center"
        >
          <Spinner />
          <Text color="gray" size="2">
            Loading run information…
          </Text>
        </Flex>
      );
    }

    if (runError) {
      return (
        <ErrorNotice
          title="Unable to load run"
          message={describeError(runError)}
          onRetry={handleRefresh}
        />
      );
    }

    if (!run) {
      return (
        <Callout.Root color="red">
          <Callout.Text className="font-medium">
            Run “{normalizedRunName}” was not found.
          </Callout.Text>
        </Callout.Root>
      );
    }

    const notebook = run.notebook;
    if (!notebook || notebook.cells.length === 0) {
      return (
        <Callout.Root color="yellow">
          <Callout.Text className="font-medium">
            Notebook data for this run is empty.
          </Callout.Text>
        </Callout.Root>
      );
    }

    return (
      <NotebookViewer
        ref={notebookViewerRef}
        notebook={notebook}
        initialCellTarget={decodedCellTarget || undefined}
        cellScrollEnabled={cellScrollEnabled}
      />
    );
  }, [
    decodedCellTarget,
    handleRefresh,
    isLoading,
    cellScrollEnabled,
    normalizedRunName,
    run,
    runError,
  ]);

  return (
    <RunmeContentWrapper>
      <Flex className="flex-col gap-4 p-4 pt-0">
        <div className="sticky top-0 z-10 bg-white shadow-xs">
          <div className="space-y-4 pt-4 pb-4">
            <RunMetadata
              isLoading={isRunLoading}
              isRefreshing={isRunFetching}
              onRefresh={handleRefresh}
              onScrollToBottom={handleScrollToBottom}
              run={run}
              runName={normalizedRunName}
            />
          </div>
        </div>
        <Box className="min-h-0 flex-1 overflow-auto rounded-md border border-gray-200 bg-gray-50 p-4">
          {pageContent}
        </Box>
      </Flex>
    </RunmeContentWrapper>
  );
}

interface RunMetadataProps {
  run?: Run;
  runName?: string;
  isLoading: boolean;
  isRefreshing: boolean;
  onRefresh: () => void;
  onScrollToBottom: () => void;
}

function RunMetadata({
  run,
  runName,
  isLoading,
  isRefreshing,
  onRefresh,
  onScrollToBottom,
}: RunMetadataProps) {
  const notebookMetadata = run?.notebook?.metadata ?? {};
  const hasNotebookMetadata = Object.keys(notebookMetadata).length > 0;
  const metadataTitle = runName?.trim() || run?.metadata?.name || "(unnamed)";

  return (
    <Box className="rounded-md border border-gray-200 bg-white p-4 shadow-xs">
      <Flex align="center" justify="between" className="gap-4">
        <Heading size="6" weight="bold">
          Run: {metadataTitle}
        </Heading>
        <Flex align="center" className="gap-2">
          <Button
            onClick={onRefresh}
            variant="soft"
            disabled={isLoading || isRefreshing}
          >
            Refresh
          </Button>
          <Button onClick={onScrollToBottom} size="2" variant="solid">
            Scroll to bottom
          </Button>
        </Flex>
      </Flex>
      {isLoading ? (
        <Text className="mt-3" color="gray" size="2">
          Loading metadata...
        </Text>
      ) : null}
      {!isLoading && hasNotebookMetadata ? (
        <div className="mt-3">
          <NotebookMetadataSection metadata={notebookMetadata} />
        </div>
      ) : null}
    </Box>
  );
}

function ErrorNotice({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <Box className="space-y-3">
      <Callout.Root color="red">
        <Callout.Text className="font-semibold">{title}</Callout.Text>
        <Callout.Text>{message}</Callout.Text>
      </Callout.Root>
      {onRetry ? (
        <Button onClick={onRetry} variant="surface">
          Try again
        </Button>
      ) : null}
    </Box>
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "An unknown error occurred.";
}

const RESPONSE_ID_KEY = "openai.com/responseid";
const RUN_NAME_KEY = "aisre.openai.org/runname";
const TRACE_ID_KEY = "aisre.openai.org/traceid";
const CREATED_AT_KEY = "aisre.openai.org/createdAt";
const STATEFUL_RUNME_OUTPUT_ITEMS_MIME = "stateful.runme/output-items";
const STATEFUL_RUNME_TERMINAL_MIME = "stateful.runme/terminal";
const PNG_MIME_TYPE = "image/png";
const PLATFORM_LOGS_BASE_URL = "https://platform.openai.com/logs";
const GRAFANA_BASE_URL =
  "https://grafana.gateway.obs-1.internal.api.openai.org/explore";
const GRAFANA_DATASOURCE_UID = "P868F181D1D76E0DD";
// Cell anchors live below a sticky header; nudging keeps the content visible once in view.
const CELL_SCROLL_STICKY_OFFSET_PX = 310;
// Late-loading assets (e.g., charts, images) can shift layout after our initial scroll. We retry
// for up to ~1s (60 frames) and stop once the viewport is within 2px of the desired offset.
const CELL_SCROLL_ADJUST_ATTEMPTS = 60;
const CELL_SCROLL_ADJUST_TOLERANCE = 2;

function findCellAnchorElement(cellTarget: string): HTMLElement | null {
  if (!cellTarget) {
    return null;
  }

  let target = document.getElementById(cellTarget);
  if (target instanceof HTMLElement) {
    return target;
  }

  const selector = `[data-ref-id="${cellTarget.replace(/"/g, '\\"')}"]`;
  try {
    target = document.querySelector(selector);
    if (target instanceof HTMLElement) {
      return target;
    }
  } catch (error) {
    // Ignore invalid selector errors and fall back to CSS.escape.
  }

  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    const escaped = CSS.escape(cellTarget);
    try {
      target = document.querySelector(`[data-ref-id="${escaped}"]`);
      if (target instanceof HTMLElement) {
        return target;
      }
    } catch (error) {
      // Ignore CSS escape failures.
    }
  }

  return null;
}

// Computes the window scrollTop that positions the element just below the sticky header.
function computeDesiredScrollTop(target: HTMLElement): number {
  const rect = target.getBoundingClientRect();
  const absoluteTop = rect.top + window.scrollY;
  return Math.max(0, absoluteTop - CELL_SCROLL_STICKY_OFFSET_PX);
}

// Smoothly scrolls to the desired top; subsequent retries fall back to instant positioning.
function scrollWindowToElement(
  target: HTMLElement,
  behavior: ScrollBehavior = "smooth",
) {
  const desiredTop = computeDesiredScrollTop(target);
  window.scrollTo({ top: desiredTop, behavior });
}

const textDecoder = new TextDecoder("utf-8", { fatal: false });

const markdownComponents: Components = {
  h1: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h1 className="mt-3 mb-6 font-semibold text-gray-900" {...props} />
  ),
  h2: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 className="mt-3 mb-3 text-lg font-semibold text-gray-900" {...props} />
  ),
  p: (props: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p className="text-gray-900" {...props} />
  ),
  ul: (props: React.HTMLAttributes<HTMLUListElement>) => (
    <ul className="ml-5 list-disc space-y-2 text-gray-900" {...props} />
  ),
  ol: (props: React.HTMLAttributes<HTMLOListElement>) => (
    <ol className="ml-5 list-decimal space-y-2 text-gray-900" {...props} />
  ),
  li: (props: React.LiHTMLAttributes<HTMLLIElement>) => (
    <li className="text-gray-900" {...props} />
  ),
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a className="text-blue-600 underline" {...props} />
  ),
  code: ({
    inline,
    ...props
  }: { inline?: boolean } & React.HTMLAttributes<HTMLElement>) => (
    <code
      className={`rounded bg-gray-100 px-1 py-0.5 text-[12px] text-gray-900 ${
        inline ? "" : "block"
      }`}
      {...props}
    />
  ),
};

type NotebookMetadata = Notebook["metadata"];

const NotebookViewer = forwardRef<NotebookViewerHandle, NotebookViewerProps>(
  function NotebookViewer(
    { notebook, initialCellTarget, cellScrollEnabled },
    ref,
  ) {
    const cells =
      notebook.cells?.filter((cell): cell is Cell => Boolean(cell)) ?? [];
    const hasAppliedCellScrollRef = useRef(false);
    const adjustRafRef = useRef<number | null>(null); // Tracks the in-flight correction loop.
    const toastTimeoutRef = useRef<number | null>(null);
    const [copyToast, setCopyToast] = useState<{
      readonly message: string;
      readonly tone: "success" | "error";
    } | null>(null);

    const showToast = useCallback(
      (toast: { message: string; tone: "success" | "error" }) => {
        setCopyToast(toast);
        if (toastTimeoutRef.current !== null) {
          window.clearTimeout(toastTimeoutRef.current);
        }
        toastTimeoutRef.current = window.setTimeout(() => {
          setCopyToast(null);
          toastTimeoutRef.current = null;
        }, 1_000);
      },
      [],
    );

    useEffect(() => {
      return () => {
        if (toastTimeoutRef.current !== null) {
          window.clearTimeout(toastTimeoutRef.current);
          toastTimeoutRef.current = null;
        }
      };
    }, []);

    const handleCopyCellLink = useCallback(
      async (cellAnchorId: string) => {
        if (!cellAnchorId) {
          return;
        }

        const { origin, pathname, search } = window.location;
        const link = `${origin}${pathname}${search}#${encodeURIComponent(
          cellAnchorId,
        )}`;

        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(link);
          showToast({ message: "Cell link copied", tone: "success" });
          return;
        }
      },
      [showToast],
    );

    const handleScrollToBottom = useCallback(() => {
      const docEl = document.documentElement;
      const body = document.body;
      const scrollHeight = Math.max(docEl.scrollHeight, body.scrollHeight);
      const maxScrollTop = Math.max(0, scrollHeight - window.innerHeight);
      window.scrollTo({ top: maxScrollTop, behavior: "smooth" });
    }, []);

    // Expose an imperative scroll helper so the route can trigger scrolling without poking DOM nodes directly.
    useImperativeHandle(
      ref,
      () => ({
        scrollToBottom: handleScrollToBottom,
      }),
      [handleScrollToBottom],
    );

    useEffect(() => {
      if (adjustRafRef.current !== null) {
        window.cancelAnimationFrame(adjustRafRef.current);
        adjustRafRef.current = null;
      }
      hasAppliedCellScrollRef.current = false;
    }, [initialCellTarget, cellScrollEnabled]);

    useEffect(() => {
      if (
        !cellScrollEnabled ||
        !initialCellTarget ||
        hasAppliedCellScrollRef.current
      ) {
        return;
      }

      const raf = window.requestAnimationFrame(() => {
        const target = findCellAnchorElement(initialCellTarget);
        if (!target) {
          return;
        }

        if (target instanceof HTMLDetailsElement) {
          target.open = true;
        }

        let attempts = 0;

        // Repeatedly realign until layout stabilises so the target is not hidden by new content.
        const adjustScroll = () => {
          scrollWindowToElement(target, attempts === 0 ? "smooth" : "auto");

          const desiredTop = computeDesiredScrollTop(target);
          const delta = Math.abs(window.scrollY - desiredTop);
          attempts += 1;

          // Stop when the viewport is close enough or we've tried long enough to cover image loads.
          if (
            delta <= CELL_SCROLL_ADJUST_TOLERANCE ||
            attempts >= CELL_SCROLL_ADJUST_ATTEMPTS
          ) {
            adjustRafRef.current = null;
            return;
          }

          adjustRafRef.current = window.requestAnimationFrame(adjustScroll);
        };

        adjustScroll();

        hasAppliedCellScrollRef.current = true;
      });

      return () => {
        window.cancelAnimationFrame(raf);
        if (adjustRafRef.current !== null) {
          window.cancelAnimationFrame(adjustRafRef.current);
          adjustRafRef.current = null;
        }
      };
    }, [cells.length, cellScrollEnabled, initialCellTarget]);

    return (
      <div className="flex h-full min-h-0 w-full flex-col text-sm text-gray-900">
        <div className="flex-1 min-h-0 overflow-y-auto pr-1">
          <div className="space-y-4">
            {cells.map((cell, index) => (
              <NotebookCellView
                key={cell.refId || `cell-${index}`}
                cell={cell}
                index={index}
                onCopyCellLink={handleCopyCellLink}
              />
            ))}
          </div>
        </div>
        {copyToast ? (
          <div className="pointer-events-none fixed left-1/2 top-4 z-50 -translate-x-1/2 transform">
            <div
              role="status"
              aria-live="polite"
              className={`pointer-events-auto rounded-md border px-4 py-2 text-sm shadow-lg ${
                copyToast.tone === "success"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                  : "border-red-200 bg-red-50 text-red-900"
              }`}
            >
              {copyToast.message}
            </div>
          </div>
        ) : null}
      </div>
    );
  },
);

const KEYS_TO_DISPLAY = [
  "aisre.openai.org/createdAt",
  "aisre.openai.org/datadogEventURL",
  "aisre.openai.org/traceid",
];

function NotebookMetadataSection({ metadata }: { metadata: NotebookMetadata }) {
  const entries = Object.entries(metadata ?? {}).filter(([key]) =>
    KEYS_TO_DISPLAY.includes(key),
  );
  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="min-w-0 space-y-3">
      <Text size="3" weight="bold">
        Notebook Metadata
      </Text>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[320px] table-auto border-collapse text-sm">
          <thead>
            <tr className="bg-gray-200">
              <th className="border border-gray-200 px-3 py-2 text-left font-semibold text-gray-900">
                Key
              </th>
              <th className="border border-gray-200 px-3 py-2 text-left font-semibold text-gray-900">
                Value
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([key, value]) => (
              <tr key={key} className="odd:bg-white even:bg-gray-50">
                <th className="border border-gray-200 px-3 py-2 text-left font-medium text-gray-700">
                  {key}
                </th>
                <td className="border border-gray-200 px-3 py-2 text-gray-900">
                  {renderMetadataValue(key, value, metadata)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function renderMetadataValue(
  key: string,
  value: string,
  metadata: NotebookMetadata,
): ReactNode {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }

  const createdAt = metadata?.[CREATED_AT_KEY];

  if (key === TRACE_ID_KEY) {
    const href = buildGrafanaExploreUrl({ traceId: trimmed }, createdAt);
    if (href) {
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-blue-600 hover:underline"
        >
          {trimmed}
        </a>
      );
    }
  }

  if (key === RUN_NAME_KEY) {
    const href = buildGrafanaExploreUrl({ runName: trimmed }, createdAt);
    if (href) {
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-blue-600 hover:underline"
        >
          {trimmed}
        </a>
      );
    }
  }

  if (trimmed.toLowerCase().startsWith("http")) {
    return (
      <a
        href={trimmed}
        target="_blank"
        rel="noreferrer"
        className="text-blue-600 hover:underline"
      >
        {trimmed}
      </a>
    );
  }

  return trimmed;
}

function NotebookCellView({
  cell,
  index,
  onCopyCellLink,
}: {
  cell: Cell;
  index: number;
  onCopyCellLink?: (cellAnchorId: string) => void;
}) {
  const language = cell.languageId?.trim();
  const responseId = cell.metadata?.[RESPONSE_ID_KEY]?.trim();
  const cellAnchorId = cell.refId?.trim();
  const hasOutputs = cell.outputs?.some(hasDisplayableItems) ?? false;

  const handleAnchorClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (!cellAnchorId) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void onCopyCellLink?.(cellAnchorId);
    },
    [cellAnchorId, onCopyCellLink],
  );

  return (
    <details
      id={cellAnchorId ?? undefined}
      data-ref-id={cellAnchorId ?? undefined}
      className="rounded-md border border-gray-200 bg-white p-4 shadow-xs"
      open
    >
      <summary className="cursor-pointer text-sm font-medium text-gray-900">
        <span className="font-semibold text-gray-900">Cell {index}</span>
        <span>&emsp;</span>
        <span className="text-gray-700">
          id:&nbsp;
          {cellAnchorId ? (
            <a
              href={`#${cellAnchorId}`}
              onClick={handleAnchorClick}
              title="Copy link to this cell"
            >
              {cellAnchorId}
            </a>
          ) : (
            "(none)"
          )}
        </span>
        <span>&emsp;</span>
        <span className="text-gray-700">
          kind:&nbsp;
          {getCellKindDescription(cell.kind)}
          {language
            ? cell.kind === CellKind.CODE
              ? ` (${language})`
              : `, language=${language}`
            : ""}
        </span>
        {responseId ? (
          <>
            <span>&emsp;</span>
            <span className="text-gray-700">
              response:&nbsp;
              <a
                href={`${PLATFORM_LOGS_BASE_URL}/${responseId}`}
                target="_blank"
                rel="noreferrer"
                className="text-blue-600 hover:underline"
              >
                {responseId}
              </a>
            </span>
          </>
        ) : null}
      </summary>
      <div className="mt-3 text-sm text-gray-900">
        {cell.kind === CellKind.CODE ? (
          <pre className="max-h-120 overflow-auto whitespace-pre-wrap break-words rounded-md border border-gray-200 bg-gray-100 p-3 text-xs leading-relaxed">
            <code>{cell.value}</code>
          </pre>
        ) : (
          <div className="max-h-120 overflow-auto rounded-md bg-white p-3 text-sm leading-relaxed">
            <ReactMarkdown
              className="space-y-3"
              skipHtml={false}
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeRaw as any]}
              components={markdownComponents}
            >
              {cell.value || ""}
            </ReactMarkdown>
          </div>
        )}
      </div>
      {hasOutputs ? (
        <div className="mt-4 space-y-3 border-t border-gray-200 pt-4">
          {cell.outputs.map((output, outputIndex) => (
            <NotebookOutputSection
              key={`cell-${cell.refId || index}-output-${outputIndex}`}
              output={output}
              index={outputIndex}
            />
          ))}
        </div>
      ) : null}
    </details>
  );
}

function NotebookOutputSection({
  output,
  index,
}: {
  output: CellOutput;
  index: number;
}) {
  const displayableItems = output.items?.filter(isDisplayableOutputItem) ?? [];
  if (displayableItems.length === 0) {
    return null;
  }

  return (
    <div className="rounded-md border border-gray-200 bg-gray-100 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-700">
        Output {index}
      </div>
      <div className="mt-2 space-y-3 pr-1">
        {displayableItems.map((item, itemIndex) => (
          <NotebookOutputItemView
            key={itemIndex}
            item={item}
            index={itemIndex}
          />
        ))}
      </div>
    </div>
  );
}

function NotebookOutputImageView({ alt, src }: { alt: string; src: string }) {
  return (
    <img
      alt={alt}
      src={src}
      className="max-h-[480px] w-full rounded-md border border-gray-200 bg-white object-contain"
    />
  );
}

function NotebookOutputItemView({
  item,
  index,
}: {
  item: CellOutputItem;
  index: number;
}) {
  const mime = item.mime || "";

  const baseUrl = useBaseUrl();
  const isIopub = mime === IOPUB_MIME_TYPE;
  const iopubIncomplete =
    item.metadata?.[IOPUB_INCOMPLETE_METADATA_KEY] === "true";
  const hasIopubMetadata =
    item.metadata?.[IOPUB_INCOMPLETE_METADATA_KEY] === "true" ||
    item.metadata?.[IOPUB_INCOMPLETE_METADATA_KEY] === "false";

  let content: ReactNode;
  // Handle runme asset pointers
  if (mime === RUNME_ASSET_MIME || mime === LEGACY_ASSET_MIME) {
    const ref = decodeAssetRef(item.data ?? new Uint8Array());
    if (ref) {
      const url = getAssetProxyUrl(baseUrl, ref);
      if (ref.mimeType.startsWith("image/")) {
        content = (
          <NotebookOutputImageView
            alt={`Cell output item ${index}`}
            src={url}
          />
        );
      } else {
        const href = getAssetProxyUrl(baseUrl, ref);
        content = (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 underline"
          >
            Download asset ({ref.mimeType || "unknown"})
          </a>
        );
      }
    }
  } else if (mime === PNG_MIME_TYPE) {
    const base64 = uint8ArrayToBase64(item.data ?? new Uint8Array());
    const src = `data:${mime};base64,${base64}`;
    content = (
      <NotebookOutputImageView alt={`Cell output item ${index}`} src={src} />
    );
  } else if (mime === "text/html") {
    const html = decodeOutputText(item.data ?? new Uint8Array());
    content = (
      <div
        className="max-h-96 overflow-auto rounded-md border border-gray-200 bg-white p-3 text-sm text-gray-900"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  } else if (isIopub) {
    // Render IOPub JSON output separately so we can annotate streaming state.
    const text = decodeOutputText(item.data ?? new Uint8Array());
    content = (
      <div
        id={`notebook-output-iopub-${index}`}
        className="rounded-md border border-dashed border-amber-300 bg-amber-50 p-3 text-xs text-amber-900"
      >
        <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">
          {iopubIncomplete
            ? "IOPub message (streaming)"
            : "IOPub message (complete)"}
        </div>
        <pre className="mt-2 whitespace-pre-wrap break-words">{text}</pre>
      </div>
    );
  } else {
    const text = decodeOutputText(item.data ?? new Uint8Array());
    content = (
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-gray-900">
        {text}
      </pre>
    );
  }

  return (
    <div id={`notebook-output-item-${index}`} className="rounded-md shadow-xs">
      <div
        id={`notebook-output-item-header-${index}`}
        className="text-xs font-medium uppercase tracking-wide text-gray-700"
      >
        Item {index} - mime={mime}
        {hasIopubMetadata ? (iopubIncomplete ? " (streaming)" : " (complete)") : ""}
      </div>
      <div id={`notebook-output-item-body-${index}`} className="mt-2">
        {content}
      </div>
    </div>
  );
}

function hasDisplayableItems(output: CellOutput): boolean {
  return output.items?.some(isDisplayableOutputItem) ?? false;
}

function isDisplayableOutputItem(item: CellOutputItem): boolean {
  const mime = item.mime || "";
  return (
    mime !== STATEFUL_RUNME_OUTPUT_ITEMS_MIME &&
    mime !== STATEFUL_RUNME_TERMINAL_MIME &&
    item.data instanceof Uint8Array
  );
}

function decodeOutputText(data: Uint8Array): string {
  if (!(data instanceof Uint8Array) || data.length === 0) {
    return "";
  }
  try {
    return textDecoder.decode(data);
  } catch {
    return "";
  }
}

function decodeAssetRef(data: Uint8Array): AssetRef | undefined {
  const text = decodeOutputText(data);
  if (!text) return undefined;
  try {
    const obj = JSON.parse(text) as { uri?: string; mimeType?: string };
    if (
      obj &&
      typeof obj.uri === "string" &&
      obj.uri.startsWith("aisrefile://")
    ) {
      return {
        uri: obj.uri,
        mimeType: obj.mimeType || "application/octet-stream",
      };
    }
  } catch {
    // fallthrough
  }
  return undefined;
}

function uint8ArrayToBase64(data: Uint8Array): string {
  if (!(data instanceof Uint8Array) || data.length === 0) {
    return "";
  }

  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return base64Encode(binary);
}

function base64Encode(value: string): string {
  if (typeof globalThis.btoa === "function") {
    return globalThis.btoa(value);
  }
  return "";
}

function getCellKindDescription(kind: CellKind): string {
  switch (kind) {
    case CellKind.CODE:
      return "CELL_KIND_CODE";
    case CellKind.MARKUP:
      return "CELL_KIND_MARKUP";
    case CellKind.DOC_RESULTS:
      return "CELL_KIND_DOC_RESULTS";
    default:
      return "CELL_KIND_UNSPECIFIED";
  }
}

function buildGrafanaExploreUrl(
  params: Record<string, string>,
  createdAt?: string,
): string | undefined {
  const filteredEntries = Object.entries(params).filter(
    ([, value]) => value && value.trim() !== "",
  );
  if (filteredEntries.length === 0) {
    return undefined;
  }

  let from: Date | undefined;
  let to: Date | undefined;

  if (createdAt) {
    const createdDate = new Date(createdAt);
    if (!Number.isNaN(createdDate.getTime())) {
      from = new Date(createdDate.getTime() - 60_000);
      to = new Date(createdDate.getTime() + 30 * 60_000);
    }
  }

  if (!from || !to) {
    to = new Date();
    from = new Date(to.getTime() - 24 * 60 * 60_000);
  }

  const simplelogParams = filteredEntries.reduce<Record<string, string>>(
    (acc, [key, value]) => {
      acc[key] = value.trim();
      return acc;
    },
    {},
  );

  const panes = {
    eja: {
      datasource: GRAFANA_DATASOURCE_UID,
      queries: [
        {
          refId: "A",
          datasource: {
            type: "grafana-clickhouse-datasource",
            uid: GRAFANA_DATASOURCE_UID,
          },
          editorType: "simplelog",
          builderOptions: {
            meta: {},
            simplelogQuery: buildSimplelogQuery(simplelogParams),
            limit: 1000,
            oql: {},
            tableType: "applied_logs",
          },
          pluginVersion: "4.5.0",
          format: 2,
          queryType: "logs",
          meta: { isMainQuery: true },
          rawSql: "",
        },
      ],
      range: {
        from: from.toISOString(),
        to: to.toISOString(),
      },
      panelsState: {
        logs: {
          columns: { 0: "timestamp", 1: "body" },
          visualisationType: "logs",
        },
      },
      compact: false,
    },
  };

  try {
    const url = new URL(GRAFANA_BASE_URL);
    url.searchParams.set("schemaVersion", "1");
    url.searchParams.set("panes", JSON.stringify(panes));
    url.searchParams.set("orgId", "1");
    return url.toString();
  } catch {
    return undefined;
  }
}

function buildSimplelogQuery(params: Record<string, string>): string {
  const baseParts = ['service:"aisre-server"', 'container:"aisre-server"'];
  const keys = Object.keys(params).sort();
  for (const key of keys) {
    const value = sanitizeForGrafana(params[key]);
    baseParts.push(`${key}:"${value}"`);
  }
  return baseParts.join(" ");
}

function sanitizeForGrafana(value: string): string {
  return value.replace(/"/g, '\\"');
}
