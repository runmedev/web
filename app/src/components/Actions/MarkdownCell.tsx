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
 * These match the styling used elsewhere in the app for markdown rendering.
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
  /** The CellData object containing the markdown content and state */
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
        [cellData]
      ),
      useCallback(() => cellData.snapshot, [cellData]),
      useCallback(() => cellData.snapshot, [cellData])
    );

    // `rendered` state controls whether we show rendered markdown or the editor
    // Start in rendered mode unless the cell is empty (new cell)
    const [rendered, setRendered] = useState(() => {
      const value = cell?.value ?? "";
      return value.trim().length > 0;
    });

    // Get the current cell value
    const value = cell?.value ?? "";

    /**
     * Handle switching to edit mode when user double-clicks rendered content.
     */
    const handleDoubleClick = useCallback(() => {
      setRendered(false);
    }, []);

    /**
     * Handle keyboard activation on the rendered container for accessibility.
     * Enter or Space activates edit mode (like a button).
     */
    const handleRenderedKeyDown = useCallback(
      (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setRendered(false);
        }
      },
      []
    );

    /**
     * Handle blur event - switch back to rendered mode when clicking away.
     * Uses relatedTarget to check if focus moved outside the editor container.
     * Empty cells stay in edit mode.
     */
    const handleBlur = useCallback(
      (event: FocusEvent<HTMLDivElement>) => {
        // If focus moved to an element still inside the editor container, don't render
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }
        // If content is empty, stay in edit mode
        if (!value.trim()) {
          return;
        }
        setRendered(true);
      },
      [value]
    );

    /**
     * Handle keyboard events on the editor container.
     * Escape key switches back to rendered mode (if not empty).
     */
    const handleEditorKeyDown = useCallback(
      (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") {
          // Only render if there's content; empty cells stay in edit mode
          if (value.trim()) {
            setRendered(true);
          }
        }
      },
      [value]
    );

    /**
     * Handle content changes from the editor.
     * Updates the cell data.
     */
    const handleEditorChange = useCallback(
      (newValue: string) => {
        if (!cell) return;
        const updated = create(parser_pb.CellSchema, cell);
        updated.value = newValue;
        cellData.update(updated);
      },
      [cell, cellData]
    );

    /**
     * Handle "run" action for markdown cells - just renders the markdown.
     * This matches Jupyter's behavior where Shift+Enter on a markdown cell
     * renders it and moves to the next cell.
     */
    const handleRun = useCallback(() => {
      if (value.trim()) {
        setRendered(true);
      }
    }, [value]);

    // Memoize the rendered markdown to avoid unnecessary re-renders
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
          // Rendered markdown view - double-click or keyboard to edit
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
          // Editor view - blur or Escape to render
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
    // Only re-render if the cellData reference changes
    return prevProps.cellData === nextProps.cellData;
  }
);

MarkdownCell.displayName = "MarkdownCell";

export default MarkdownCell;
