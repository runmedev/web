/**
 * MarkdownCell - In-place markdown rendering component (Jupyter-style)
 *
 * This component implements Jupyter-style in-place markdown rendering:
 * - When `rendered=true`: Shows rendered markdown HTML
 * - When `rendered=false`: Shows the Monaco editor for editing
 * - Double-click on rendered content switches to edit mode
 * - Blur (clicking away) or pressing Escape switches back to render mode
 *
 * State Management:
 * - `rendered` boolean controls which view is shown
 * - The component swaps between Editor and rendered markdown in-place
 * - No separate output cell is needed for markdown cells
 *
 * Security Note:
 * - Raw HTML is disabled by default for security (XSS prevention)
 * - Only trusted markdown features are rendered via remark-gfm
 */

import {
  memo,
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { create } from "@bufbuild/protobuf";
import { parser_pb } from "../../runme/client";
import type { CellData } from "../../lib/notebookData";
import Editor from "./Editor";
import { fontSettings } from "./CellConsole";

/**
 * Custom markdown components for consistent styling.
 * These match the Colab-inspired styling used elsewhere in the app.
 */
const markdownComponents: Components = {
  h1: ({ children, ...props }) => (
    <h1 className="text-2xl font-bold mb-4 mt-6 text-gray-900" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="text-xl font-bold mb-3 mt-5 text-gray-900" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="text-lg font-semibold mb-2 mt-4 text-gray-900" {...props}>
      {children}
    </h3>
  ),
  p: ({ children, ...props }) => (
    <p className="mb-3 text-gray-800 leading-relaxed" {...props}>
      {children}
    </p>
  ),
  ul: ({ children, ...props }) => (
    <ul className="list-disc list-inside mb-3 ml-4 text-gray-800" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol className="list-decimal list-inside mb-3 ml-4 text-gray-800" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li className="mb-1" {...props}>
      {children}
    </li>
  ),
  code: ({ children, className, ...props }) => {
    const isInline = !className;
    if (isInline) {
      return (
        <code
          className="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono text-gray-800"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <code
        className={`block bg-gray-100 p-3 rounded-md text-sm font-mono overflow-x-auto ${className}`}
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children, ...props }) => (
    <pre className="bg-gray-100 p-3 rounded-md overflow-x-auto mb-3" {...props}>
      {children}
    </pre>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote
      className="border-l-4 border-gray-300 pl-4 italic text-gray-700 my-3"
      {...props}
    >
      {children}
    </blockquote>
  ),
  a: ({ children, href, ...props }) => (
    <a
      href={href}
      className="text-blue-600 hover:underline"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
  table: ({ children, ...props }) => (
    <div className="overflow-x-auto mb-3">
      <table className="min-w-full border border-gray-300" {...props}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...props }) => (
    <th
      className="border border-gray-300 bg-gray-100 px-3 py-2 text-left font-semibold"
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="border border-gray-300 px-3 py-2" {...props}>
      {children}
    </td>
  ),
  hr: (props) => <hr className="my-4 border-gray-300" {...props} />,
  img: ({ src, alt, ...props }) => (
    <img
      src={src}
      alt={alt || ""}
      className="max-w-full h-auto rounded-md my-2"
      {...props}
    />
  ),
};

interface MarkdownCellProps {
  cellData: CellData;
}

/**
 * MarkdownCell renders markdown content in-place with edit/render mode toggle.
 *
 * Interaction patterns (Jupyter-style):
 * - Double-click rendered content → enter edit mode
 * - Click away (blur) from editor → render markdown (if not empty)
 * - Press Escape while editing → render markdown (if not empty)
 * - Empty cells start in edit mode and stay in edit mode
 */
const MarkdownCell = memo(
  ({ cellData }: MarkdownCellProps) => {
    // Subscribe to cell data changes using useSyncExternalStore for tearing-safe reads
    const cell = useSyncExternalStore(
      useCallback(
        (listener) => cellData.subscribeToContentChange(listener),
        [cellData],
      ),
      useCallback(() => cellData.snapshot, [cellData]),
      useCallback(() => cellData.snapshot, [cellData]),
    );

    // `rendered` state controls whether we show rendered markdown or the editor.
    // Start in rendered mode unless the cell is empty (new cell).
    const [rendered, setRendered] = useState(() => {
      const value = cell?.value ?? "";
      return value.trim().length > 0;
    });

    const value = cell?.value ?? "";

    /** Switch to edit mode on double-click. */
    const handleDoubleClick = useCallback(() => {
      setRendered(false);
    }, []);

    /** Allow Enter/Space to activate edit mode for accessibility. */
    const handleRenderedKeyDown = useCallback(
      (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setRendered(false);
        }
      },
      [],
    );

    /**
     * Switch back to rendered mode when focus leaves the editor container.
     * Empty cells stay in edit mode.
     */
    const handleBlur = useCallback(
      (event: FocusEvent<HTMLDivElement>) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }
        if (!value.trim()) {
          return;
        }
        setRendered(true);
      },
      [value],
    );

    /** Escape key switches back to rendered mode (if cell has content). */
    const handleEditorKeyDown = useCallback(
      (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") {
          if (value.trim()) {
            setRendered(true);
          }
        }
      },
      [value],
    );

    /** Update cell data when editor content changes. */
    const handleEditorChange = useCallback(
      (newValue: string) => {
        if (!cell) return;
        const updated = create(parser_pb.CellSchema, cell);
        updated.value = newValue;
        cellData.update(updated);
      },
      [cell, cellData],
    );

    /** "Run" on a markdown cell just renders it (matches Jupyter Shift+Enter). */
    const handleRun = useCallback(() => {
      if (value.trim()) {
        setRendered(true);
      }
    }, [value]);

    const renderedMarkdown = useMemo(() => {
      if (!value.trim()) {
        return (
          <div className="text-gray-400 italic py-2">
            Double-click to edit markdown...
          </div>
        );
      }
      return (
        <div className="prose prose-sm max-w-none">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={markdownComponents}
          >
            {value}
          </ReactMarkdown>
        </div>
      );
    }, [value]);

    if (!cell) {
      return null;
    }

    return (
      <div
        id={`markdown-cell-${cell.refId}`}
        className="relative w-full min-w-0"
        data-testid="markdown-cell"
        data-rendered={rendered}
      >
        {rendered ? (
          <div
            id={`markdown-rendered-${cell.refId}`}
            className="cursor-text rounded-md border border-transparent hover:border-gray-200 hover:bg-gray-50/50 p-4 transition-colors"
            onDoubleClick={handleDoubleClick}
            onKeyDown={handleRenderedKeyDown}
            tabIndex={0}
            aria-label="Double-click or press Enter to edit markdown"
            data-testid="markdown-rendered"
          >
            {renderedMarkdown}
          </div>
        ) : (
          <div
            id={`markdown-editor-${cell.refId}`}
            className="rounded-md border border-sky-200 overflow-hidden w-full min-w-0 max-w-full"
            onBlur={handleBlur}
            onKeyDown={handleEditorKeyDown}
            data-testid="markdown-editor"
          >
            <Editor
              id={`md-editor-${cell.refId}`}
              value={value}
              language="markdown"
              fontSize={fontSettings.fontSize}
              fontFamily={fontSettings.fontFamily}
              onChange={handleEditorChange}
              onEnter={handleRun}
            />
            <div className="bg-gray-100 border-t border-gray-200 px-3 py-1 text-xs text-gray-500">
              Press <kbd className="px-1 py-0.5 bg-gray-200 rounded">Esc</kbd>{" "}
              or click away to render
            </div>
          </div>
        )}
      </div>
    );
  },
  (prevProps, nextProps) => {
    return prevProps.cellData === nextProps.cellData;
  },
);

MarkdownCell.displayName = "MarkdownCell";

export default MarkdownCell;
