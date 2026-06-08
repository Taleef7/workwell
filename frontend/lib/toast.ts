export type ToastVariant = "success" | "error" | "warning" | "info";

/**
 * Emit a transient toast. Bridged to the @mieweb/ui Toast system by
 * `components/global-toast.tsx` (which must be rendered inside a ToastProvider).
 * `variant` defaults to "success" to preserve the prior green-confirmation look.
 */
export function emitToast(message: string, variant: ToastVariant = "success") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("workwell:toast", { detail: { message, variant } })
  );
}
