import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type ToastKind = "ok" | "err";
type ToastItem = { id: number; kind: ToastKind; text: string };

type ToastApi = {
  push: (kind: ToastKind, text: string, ms?: number) => void;
  ok: (text: string, ms?: number) => void;
  err: (text: string, ms?: number) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((kind: ToastKind, text: string, ms = 4200) => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev.slice(-4), { id, kind, text }]);
    window.setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), ms);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      push,
      ok: (text, ms) => push("ok", text, ms),
      err: (text, ms) => push("err", text, ms),
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast outside provider");
  return ctx;
}
