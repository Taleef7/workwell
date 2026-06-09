"use client";

import { ToastProvider } from "@mieweb/ui";
import { AuthProvider } from "@/components/auth-provider";
import GlobalToast from "@/components/global-toast";

/**
 * Client provider boundary for the app. Kept as a "use client" module so the
 * @mieweb/ui barrel (which evaluates React.createContext at module load) is
 * never pulled into a Server Component graph.
 */
export function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <AuthProvider>
        {children}
        <GlobalToast />
      </AuthProvider>
    </ToastProvider>
  );
}
