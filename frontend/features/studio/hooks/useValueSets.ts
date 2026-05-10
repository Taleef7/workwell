"use client";

import { useState, useCallback } from "react";
import type { ApiClient } from "@/lib/api/client";
import type { ValueSetRef } from "../types";

export function useValueSets(api: ApiClient) {
  const [allValueSets, setAllValueSets] = useState<ValueSetRef[]>([]);

  const load = useCallback(async () => {
    try {
      const data = await api.get<ValueSetRef[]>("/api/value-sets");
      setAllValueSets(data);
    } catch {
      // non-fatal; page-level error state handles critical failures
    }
  }, [api]);

  return { allValueSets, load };
}
