import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Polls `fn` on an interval for the lifetime of the mounted view, with an
 * immediate first fire. Pauses while the tab is hidden (and refires the
 * moment it becomes visible again) so a forgotten background tab doesn't
 * hammer the workspace API. Like use-session-inbox, the latest callback
 * is kept in a ref so callers can pass inline closures without tearing
 * down the interval every render.
 *
 * Errors don't clear the last good `data` — a single failed poll on a
 * live dashboard should degrade to "slightly stale", not "blank page".
 */
export function usePoll<T>(
  fn: () => Promise<T>,
  intervalMs: number,
): { data: T | null; error: Error | null; loading: boolean; refetch: () => void } {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumping this restarts the effect: immediate fire + fresh interval.
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let stopped = false;
    let inFlight = false;

    const poll = async () => {
      if (stopped || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const result = await fnRef.current();
        if (!stopped) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        inFlight = false;
        if (!stopped) setLoading(false);
      }
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') poll();
    };

    poll();
    const timer = setInterval(poll, intervalMs);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs, tick]);

  return { data, error, loading, refetch };
}
