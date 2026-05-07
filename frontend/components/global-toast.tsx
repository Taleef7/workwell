"use client";

import { useEffect, useState } from "react";

export default function GlobalToast() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    function onToast(event: Event) {
      const custom = event as CustomEvent<{ message?: string }>;
      if (!custom.detail?.message) return;
      setMessage(custom.detail.message);
    }
    window.addEventListener("workwell:toast", onToast as EventListener);
    return () => window.removeEventListener("workwell:toast", onToast as EventListener);
  }, []);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 2500);
    return () => clearTimeout(timer);
  }, [message]);

  if (!message) return null;

  return (
    <div className="fixed right-4 top-4 z-50 rounded bg-emerald-700 px-3 py-2 text-xs font-medium text-white shadow-lg">
      {message}
    </div>
  );
}
