import {
  type ChangeEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type KeyboardEvent,
} from "react";

import { create } from "@bufbuild/protobuf";
import { parser_pb } from "../../runme/client";
import type { CellData } from "../../lib/notebookData";
import Editor from "./Editor";
import { fontSettings } from "./CellConsole";

interface HtmlCellProps {
  cellData: CellData;
  selectedLanguage: string;
  languageSelectId: string;
  languageOptions: readonly { label: string; value: string }[];
  onLanguageChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  forceEditRequest?: number;
}

const HtmlCell = memo(
  ({
    cellData,
    selectedLanguage,
    languageSelectId,
    languageOptions,
    onLanguageChange,
    forceEditRequest = 0,
  }: HtmlCellProps) => {
    const cell = useSyncExternalStore(
      useCallback(
        (listener) => cellData.subscribeToContentChange(listener),
        [cellData],
      ),
      useCallback(() => cellData.snapshot, [cellData]),
      useCallback(() => cellData.snapshot, [cellData]),
    );

    const [rendered, setRendered] = useState(() => {
      const value = cell?.value ?? "";
      return value.trim().length > 0;
    });

    const value = cell?.value ?? "";

    useEffect(() => {
      if (!value.trim() && rendered) {
        setRendered(false);
      }
    }, [rendered, value]);

    useEffect(() => {
      if (forceEditRequest > 0) {
        setRendered(false);
      }
    }, [forceEditRequest]);

    const handleRenderedKeyDown = useCallback(
      (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setRendered(false);
        }
      },
      [],
    );

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

    const handleEditorKeyDown = useCallback(
      (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape" && value.trim()) {
          setRendered(true);
        }
      },
      [value],
    );

    const handleEditorChange = useCallback(
      (newValue: string) => {
        if (!cell) {
          return;
        }
        const updated = create(parser_pb.CellSchema, cell);
        updated.value = newValue;
        cellData.update(updated);
      },
      [cell, cellData],
    );

    const handlePreview = useCallback(() => {
      if (value.trim()) {
        setRendered(true);
      }
    }, [value]);

    const previewIframe = useMemo(
      () => (
        <iframe
          title={`html-preview-${cell?.refId ?? "cell"}`}
          sandbox=""
          srcDoc={value}
          className="h-[420px] w-full rounded-b-nb-md bg-white"
          data-testid="html-preview-frame"
        />
      ),
      [cell?.refId, value],
    );

    if (!cell) {
      return null;
    }

    return (
      <div
        id={`html-cell-${cell.refId}`}
        className="relative w-full min-w-0"
        data-testid="html-cell"
        data-rendered={rendered}
      >
        {rendered ? (
          <div
            id={`html-rendered-${cell.refId}`}
            className="overflow-hidden rounded-nb-md border border-nb-border bg-white shadow-nb-xs"
            onKeyDown={handleRenderedKeyDown}
            tabIndex={0}
            role="button"
            aria-label="Press Enter to edit HTML"
            data-testid="html-rendered"
          >
            <div className="flex items-center justify-between border-b border-nb-border bg-nb-surface-2 px-3 py-2">
              <span className="text-xs font-medium uppercase tracking-wide text-nb-text-faint">
                HTML preview
              </span>
              <button
                type="button"
                className="rounded border border-nb-border-strong px-2 py-1 text-xs text-nb-text-muted transition-colors hover:border-nb-accent hover:text-nb-accent"
                onClick={() => setRendered(false)}
                data-testid="html-edit-button"
              >
                Edit HTML
              </button>
            </div>
            {previewIframe}
          </div>
        ) : (
          <div
            id={`html-editor-${cell.refId}`}
            className="rounded-nb-md border border-nb-accent shadow-nb-sm overflow-hidden w-full min-w-0 max-w-full transition-shadow duration-200"
            onBlur={handleBlur}
            onKeyDown={handleEditorKeyDown}
            data-testid="html-editor"
          >
            <Editor
              id={`html-editor-${cell.refId}`}
              value={value}
              language="html"
              fontSize={fontSettings.fontSize}
              fontFamily={fontSettings.fontFamily}
              onChange={handleEditorChange}
              onEnter={handlePreview}
            />
            <div className="cell-toolbar">
              <div className="flex items-center gap-3">
                <select
                  id={languageSelectId}
                  value={selectedLanguage}
                  onChange={onLanguageChange}
                  className="toolbar-select"
                >
                  {languageOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="text-xs text-nb-text-muted">
                Press <kbd className="px-1 py-0.5 bg-nb-surface-3 rounded">Esc</kbd>{" "}
                or click away to preview
              </div>
            </div>
          </div>
        )}
      </div>
    );
  },
  (prevProps, nextProps) => prevProps.cellData === nextProps.cellData,
);

HtmlCell.displayName = "HtmlCell";

export default HtmlCell;
