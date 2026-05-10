"use client";

import { useState, useCallback } from "react";
import type { ApiClient } from "@/lib/api/client";
import type { OshaReference } from "../types";

export function useOshaReferences(api: ApiClient) {
  const [oshaReferences, setOshaReferences] = useState<OshaReference[]>([]);

  const load = useCallback(async () => {
    try {
      const data = await api.get<OshaReference[]>("/api/osha-references");
      setOshaReferences(data);
    } catch {
      // non-fatal
    }
  }, [api]);

  return { oshaReferences, load };
}
