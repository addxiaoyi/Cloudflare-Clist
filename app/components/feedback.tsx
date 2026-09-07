import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, AlertCircle, X } from "~/components/icons";

export type ToastType = "success" | "error" | "info";
export type ToastFn = (message: string, type?: ToastType) => void;

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  leaving: boolean;
}

const ToastContext = createContext<ToastFn>(() => {});
export const useToast = (): ToastFn => useContext(ToastContext);

const TOAST_DURATION: Record<ToastType, number> = {
  success: 2800,
  info: 2800,
  // 错误信息需要更长时间阅读
  error: 5200,
};

const TOAST_ACCENT: Record<ToastType, string> = {
  success: "text-emerald-500",
  error: "text-red-500",
  info: "text-blue-500",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, leaving: true } : t))
    );
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 220);
  }, []);

  const toast = useCallback<ToastFn>(
    (message, type = "info") => {
      const id = ++idRef.current;
      setToasts((prev) => [...prev, { id, message, type, leaving: false }]);
      setTimeout(() => dismiss(id), TOAST_DURATION[type]);
    },
    [dismiss]
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="fixed top-3 left-1/2 z-[100] flex w-full max-w-md -translate-x-1/2 flex-col items-center gap-2 px-4 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto flex w-full items-start gap-2.5 rounded-xl border border-zinc-200 bg-white px-3.5 py-2.5 text-sm shadow-lg shadow-black/5 dark:border-zinc-700 dark:bg-zinc-900 ${
              t.leaving ? "toast-out" : "toast-in"
            }`}
          >
            {t.type !== "info" && (
              <span className={`mt-0.5 shrink-0 ${TOAST_ACCENT[t.type]}`}>
                {t.type === "success" ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <AlertCircle className="h-4 w-4" />
                )}
              </span>
            )}
            <span className="min-w-0 flex-1 break-words text-zinc-700 dark:text-zinc-200">
              {t.message}
            </span>
            <button
              onClick={() => dismiss(t.id)}
              className="shrink-0 text-zinc-400 transition hover:text-zinc-600 dark:hover:text-zinc-200"
              aria-label="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn>(async () => false);
export const useConfirm = (): ConfirmFn => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<(value: boolean) => void>(() => {});

  const confirm = useCallback<ConfirmFn>((options) => {
    setPending(options);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const close = useCallback(
    (result: boolean) => {
      setPending(null);
      resolveRef.current(result);
    },
    []
  );

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm dark:bg-black/70"
          onClick={() => close(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-700">
              <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {pending.title ?? "确认操作"}
              </span>
              <button
                onClick={() => close(false)}
                className="icon-btn h-7 w-7"
                aria-label="取消"
              >
                <X />
              </button>
            </div>
            <div className="whitespace-pre-wrap px-4 py-4 text-sm text-zinc-600 dark:text-zinc-300">
              {pending.message}
            </div>
            <div className="flex gap-2 px-4 pb-4">
              <button
                type="button"
                onClick={() => close(false)}
                className="flex-1 rounded border border-zinc-200 px-4 py-2 text-sm text-zinc-600 transition hover:border-zinc-400 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-100"
              >
                {pending.cancelText ?? "取消"}
              </button>
              <button
                type="button"
                onClick={() => close(true)}
                className={`flex-1 rounded px-4 py-2 text-sm text-white transition ${
                  pending.danger
                    ? "bg-red-600 hover:bg-red-500"
                    : "bg-blue-600 hover:bg-blue-500"
                }`}
              >
                {pending.confirmText ?? "确定"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
