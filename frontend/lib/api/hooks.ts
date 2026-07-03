"use client";

import { useMemo } from "react";
import { useAuth } from "@/components/auth-provider";
import { ApiClient } from "./client";

export function useApi(): ApiClient {
  const { token, logout, updateToken } = useAuth();
  return useMemo(
    () => new ApiClient({ token, onUnauthorized: logout, onTokenRefreshed: updateToken }),
    [token, logout, updateToken]
  );
}
