"use client";

import { useEffect } from "react";
import { ToastContainer, useToast } from "@mieweb/ui";
import type { ToastVariant } from "@/lib/toast";

/**
 * Bridges the legacy `workwell:toast` window event (see `lib/toast.ts`) into the
 * @mieweb/ui Toast system and renders the toast viewport. Must be mounted inside
 * a `<ToastProvider>` (wired in the root layout).
 */
export default function GlobalToast() {
  const { toasts, dismiss, success, error, warning, info } = useToast();

  useEffect(() => {
    const byVariant: Record<ToastVariant, (message: string) => string> = {
      success,
      error,
      warning,
      info,
    };
    function onToast(event: Event) {
      const custom = event as CustomEvent<{ message?: string; variant?: ToastVariant }>;
      const message = custom.detail?.message;
      if (!message) return;
      (byVariant[custom.detail?.variant ?? "success"] ?? info)(message);
    }
    window.addEventListener("workwell:toast", onToast as EventListener);
    return () => window.removeEventListener("workwell:toast", onToast as EventListener);
  }, [success, error, warning, info]);

  return <ToastContainer toasts={toasts} position="top-right" onDismiss={dismiss} />;
}
