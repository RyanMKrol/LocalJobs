'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Owns the setBusy(key) -> setErr(null) -> await fn() -> await refetch() -> catch(setErr) ->
 * finally(setBusy(null)) block duplicated across the workflow output managers
 * (TvRecsManager/MovieRecsManager/MovieGapsManager/MissingSeasonsManager). A single hook instance
 * tracks one busy dimension, keyed by `K` — pass a row id for a per-row action, or `true` for a
 * flat bulk action. Guards against setState after unmount.
 */
export function useAction<K>(refetch: () => unknown) {
  const [busy, setBusy] = useState<K | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const run = useCallback(async (key: K, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      await refetch();
    } catch (e) {
      if (mountedRef.current) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [refetch]);

  return { busy, err, run };
}
