"use client";

import { useCallback, useEffect, useState } from "react";

import {
  parseContextUsage,
  type ContextUsage,
} from "@/lib/context-usage";
import { apiFetch } from "@/lib/projects";

/**
 * Polls GET /sessions/:id/context when the session id or refreshKey changes.
 * Live streams also push context on the terminal `cost` frame (see useAgent);
 * this hook covers reopen / compact / header display.
 */
export function useSessionContext(
  sessionId: string | null | undefined,
  refreshKey = 0,
): {
  context: ContextUsage | null;
  loading: boolean;
  refresh: () => void;
  setContext: (c: ContextUsage | null) => void;
} {
  const [context, setContext] = useState<ContextUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!sessionId) {
      setContext(null);
      return;
    }
    let cancelled = false;
    const fetchOnce = async () => {
      setLoading(true);
      try {
        const r = await apiFetch(
          `/sessions/${encodeURIComponent(sessionId)}/context`,
        );
        if (!r.ok) return;
        const data = parseContextUsage(await r.json());
        if (!cancelled) setContext(data);
      } catch {
        /* next refresh retries */
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void fetchOnce();
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey, tick]);

  return { context, loading, refresh, setContext };
}

/** POST /sessions/:id/compact — summarize older turns to free context. */
export async function compactSession(
  sessionId: string,
  instructions?: string,
): Promise<{ ok: true; context: ContextUsage | null } | { ok: false; detail: string; status: number }> {
  try {
    const res = await apiFetch(
      `/sessions/${encodeURIComponent(sessionId)}/compact`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(instructions ? { instructions } : {}),
      },
    );
    if (!res.ok) {
      let detail = `Compact failed (${res.status})`;
      try {
        const body = (await res.json()) as { detail?: string };
        if (body.detail) detail = body.detail;
      } catch {
        /* ignore */
      }
      return { ok: false, detail, status: res.status };
    }
    const data = (await res.json()) as { context?: unknown };
    return { ok: true, context: parseContextUsage(data.context) };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : "Compact failed",
      status: 0,
    };
  }
}
