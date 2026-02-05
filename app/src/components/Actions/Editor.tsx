import { memo, useCallback, useEffect, useRef, useState } from "react";

import MonacoEditor from "@monaco-editor/react";
import useResizeObserver from "use-resize-observer";

const theme = "vs-dark";

// Editor component for editing code which won't re-render unless the value changes
const Editor = memo(
  ({
    id,
    value,
    language,
    fontSize = 14,
    fontFamily = "monospace",
    onChange,
    onEnter,
  }: {
    id: string;
    value: string;
    language: string;
    fontSize?: number;
    fontFamily?: string;
    onChange: (value: string) => void;
    onEnter: () => void;
  }) => {
    // Store the latest onEnter in a ref to ensure late binding
    const onEnterRef = useRef(onEnter);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const editorRef = useRef<any>(null);
    // We keep track of the wrapping div so we can read its width. Monaco needs
    // explicit dimensions; without this the editor defaults to width/height 0.
    const containerRef = useRef<HTMLDivElement>(null);
    const [height, setHeight] = useState<number>(160);
    // Tracks whether we've hit the maximum allowed editor height. When clamped
    // we allow Monaco to show a scrollbar; otherwise we hide it so short notes
    // don't render an empty scroll track.
    const [isClamped, setIsClamped] = useState(false);
    const contentSizeListener = useRef<{ dispose: () => void } | null>(null);

    // Keep the ref updated with the latest onEnter
    useEffect(() => {
      onEnterRef.current = onEnter;
    }, [onEnter]);

    const { ref: resizeRef, width = 0 } = useResizeObserver<HTMLDivElement>();
    const setContainerRef = useCallback(
      (node: HTMLDivElement | null) => {
        containerRef.current = node;
        resizeRef(node);
      },
      [resizeRef],
    );

    // Handle resize events
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adjustHeight = useCallback(() => {
      if (!editorRef.current) {
        return;
      }
      // Ask Monaco for the content height so we can expand the editor to fit
      // the text. We clamp the value so the editor never grows beyond ~60% of
      // the viewport height.
      const contentHeight = Math.max(
        120,
        (editorRef.current.getContentHeight?.() ?? 120) + 20,
      );
      const maxHeight = Math.max(200, window.innerHeight * 0.6);
      const desiredHeight = Math.min(contentHeight, maxHeight);
      setHeight(desiredHeight);
      setIsClamped(desiredHeight >= maxHeight - 1);
      // Monaco does not auto-size horizontally either, so we read the current
      // container width (falling back to the editor DOM node) and pass both
      // dimensions through layout().
      // IMPORTANT: Never fall back to window.innerWidth - doing so can cause
      // Monaco to expand the container, pushing sibling elements off-screen.
      // If width is unmeasurable, skip layout; the resize observer effect will
      // re-layout once a real width is available.
      const measuredWidth =
        containerRef.current?.clientWidth ??
        editorRef.current.getContainerDomNode?.().clientWidth ??
        0;
      const fallbackWidth = editorRef.current.getLayoutInfo?.()?.width ?? 0;
      const width = measuredWidth || fallbackWidth;
      if (!width) {
        // Don't poison layout with a huge width; the resize observer effect
        // will re-layout once width is known.
        return;
      }
      editorRef.current.layout?.({ width, height: desiredHeight });
    }, []);

    const editorDidMount = (editor: any, monaco: any) => {
      editorRef.current = editor;

      if (!monaco?.editor) {
        return;
      }
      monaco.editor.setTheme(theme);

      if (!editor) {
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor.onKeyDown((event: any) => {
        if (event.ctrlKey && event.keyCode === 3) {
          // Use the ref to ensure we always have the latest onEnter
          onEnterRef.current();
        }
      });
      // if the value is empty, focus the editor
      if (value === "") {
        editor.focus();
      }

      adjustHeight();
      contentSizeListener.current = editor.onDidContentSizeChange(() => {
        adjustHeight();
      });
    };

    useEffect(() => {
      adjustHeight();
    }, [value, adjustHeight]);

    useEffect(() => {
      if (!editorRef.current || width <= 0) {
        return;
      }
      editorRef.current.layout?.({ width, height });
    }, [width, height]);

    useEffect(() => {
      return () => {
        contentSizeListener.current?.dispose?.();
        contentSizeListener.current = null;
      };
    }, []);

    return (
      <div
        className="w-full min-w-0 max-w-full"
        style={{ contain: "inline-size" }}
        ref={setContainerRef}
      >
        <div className="rounded-t-md overflow-hidden">
          <MonacoEditor
            key={id}
            height={`${height}px`}
            width="100%"
            defaultLanguage={language}
            value={value}
            options={{
              automaticLayout: false,
              scrollbar: {
                alwaysConsumeMouseWheel: false,
                vertical: isClamped ? "auto" : "hidden",
                horizontal: "auto",
              },
              minimap: { enabled: false },
              theme,
              wordWrap: "wordWrapColumn",
              fontSize,
              fontFamily,
              lineHeight: 20,
              scrollBeyondLastLine: false,
            }}
            onChange={(v) => {
              if (!v) {
                return;
              }
              value = v;
              onChange?.(v);
            }}
            onMount={editorDidMount}
            className="rounded-lg"
            wrapperProps={{ className: "rounded-lg" }}
          />
        </div>
      </div>
    );
  },
  (prevProps, nextProps) => {
    return prevProps.value === nextProps.value;
  },
);

export default Editor;
