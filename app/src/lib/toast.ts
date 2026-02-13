type Toast = {
  message: string;
  tone: "success" | "error";
};

type ToastListener = (toast: Toast) => void;

const listeners = new Set<ToastListener>();

export function subscribeToast(listener: ToastListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function showToast(toast: Toast): void {
  listeners.forEach((l) => l(toast));
}
