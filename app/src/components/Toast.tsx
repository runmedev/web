import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeToast } from "../lib/toast";

// GlobalToast renders transient status messages for the entire app.
export default function GlobalToast() {
  const timeoutRef = useRef<number | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    tone: "success" | "error";
  } | null>(null);

  const show = useCallback(
    (t: { message: string; tone: "success" | "error" }) => {
      setToast(t);
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = window.setTimeout(() => {
        setToast(null);
        timeoutRef.current = null;
      }, 5_000);
    },
    [],
  );

  useEffect(() => {
    const unsub = subscribeToast(show);
    return () => {
      unsub();
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, [show]);

  if (!toast) return null;

  return (
    <div
      id="global-toast-wrapper"
      className="pointer-events-none fixed left-1/2 top-4 z-50 -translate-x-1/2 transform"
    >
      <div
        id="global-toast"
        role="status"
        aria-live="polite"
        className={`pointer-events-auto rounded-md border px-4 py-2 text-sm shadow-lg ${
          toast.tone === "success"
            ? "border-emerald-200 bg-emerald-50 text-emerald-900"
            : "border-red-950 bg-red-900 text-white"
        }`}
      >
        {toast.message}
      </div>
    </div>
  );
}
