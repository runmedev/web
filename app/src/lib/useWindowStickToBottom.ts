import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

export interface WindowStickToBottomOptions {
  readonly enabled?: boolean;
  readonly thresholdPx?: number;
  readonly behavior?: ScrollBehavior;
}

/**
 * Keeps the window scrolled to the bottom when content grows,
 * but only if the user is already at (or near) the bottom.
 * Trigger the effect by passing values that change when content updates.
 */
export function useWindowStickToBottom(
  triggers: ReadonlyArray<unknown>,
  options?: WindowStickToBottomOptions,
) {
  const thresholdPx = options?.thresholdPx ?? 8;
  const enabled = options?.enabled !== false;
  const behavior = options?.behavior ?? "auto";

  const isAtBottomRef = useRef<boolean>(true);
  const rafRef = useRef<number | null>(null);

  const computeIsAtBottom = useCallback((): boolean => {
    const docEl = document.documentElement;
    const body = document.body;
    const scrollTop = window.scrollY || docEl.scrollTop || body.scrollTop || 0;
    const viewportHeight = window.innerHeight || docEl.clientHeight;
    const scrollHeight = Math.max(docEl.scrollHeight, body.scrollHeight);
    return viewportHeight + scrollTop >= scrollHeight - thresholdPx;
  }, [thresholdPx]);

  const syncIsAtBottom = useCallback(() => {
    isAtBottomRef.current = computeIsAtBottom();
  }, [computeIsAtBottom]);

  useEffect(() => {
    if (!enabled) {
      isAtBottomRef.current = false;
      return;
    }

    const onScrollOrResize = () => {
      syncIsAtBottom();
    };

    window.addEventListener("scroll", onScrollOrResize, {
      passive: true,
    } as any);
    window.addEventListener("resize", onScrollOrResize, {
      passive: true,
    } as any);

    // Initialize on mount
    onScrollOrResize();

    return () => {
      window.removeEventListener("scroll", onScrollOrResize as any);
      window.removeEventListener("resize", onScrollOrResize as any);
    };
  }, [enabled, syncIsAtBottom]);

  useLayoutEffect(() => {
    if (!enabled) return;
    if (!isAtBottomRef.current) return;

    // Use rAF to ensure layout is committed before we measure and scroll
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = requestAnimationFrame(() => {
      const docEl = document.documentElement;
      const body = document.body;
      const scrollHeight = Math.max(docEl.scrollHeight, body.scrollHeight);
      const maxScrollTop = Math.max(0, scrollHeight - window.innerHeight);
      window.scrollTo({ top: maxScrollTop, behavior });
      rafRef.current = null;
    });

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [...triggers, enabled, behavior]);
}
