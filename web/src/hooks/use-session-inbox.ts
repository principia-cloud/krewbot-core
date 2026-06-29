import { useEffect, useRef } from 'react';
import { getToken } from '@/auth/cognito';

/**
 * Subscribes to a session's server-push inbox (a long-lived SSE stream at
 * `${url}`) for the lifetime of the mounted view. The server pushes small
 * nudge events — `bg_reply`, `files_changed` — when something lands
 * out-of-band (a background task finishing, files written); the caller
 * reacts by refetching (loadHistory / loadTree).
 *
 * Like use-sse, this uses fetch + ReadableStream rather than EventSource
 * so it can send the Bearer token, which means reconnection is ours to
 * handle. On every (re)connect we fire `onActivity('sync')` so the caller
 * resyncs and nothing is missed across a dropped connection / server
 * restart. Pass `url = null` to disable (e.g. no active session, or a
 * transport that doesn't support an inbox).
 */
export function useSessionInbox(
  url: string | null,
  onActivity: (event: string) => void,
): void {
  // Keep the latest callback without re-subscribing on every render.
  const cbRef = useRef(onActivity);
  cbRef.current = onActivity;

  useEffect(() => {
    if (!url) return;

    let stopped = false;
    let controller: AbortController | null = null;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleReconnect = () => {
      if (stopped) return;
      attempt += 1;
      // 1s, 2s, 4s, … capped at 15s.
      const delay = Math.min(1000 * 2 ** (attempt - 1), 15_000);
      retryTimer = setTimeout(connect, delay);
    };

    async function connect() {
      if (stopped) return;
      const token = getToken();
      if (!token) {
        // Not authenticated yet — back off and try again; auth may arrive.
        scheduleReconnect();
        return;
      }

      controller = new AbortController();
      try {
        const res = await fetch(url!, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`inbox ${res.status}`);

        attempt = 0;
        // (Re)connected — resync once so anything that happened while we
        // were disconnected is picked up.
        cbRef.current('sync');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = 'message';

        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              cbRef.current(currentEvent);
              currentEvent = 'message';
            }
            // `:`-prefixed comment lines (heartbeats, the open marker) and
            // blank separators are ignored.
          }
        }
      } catch {
        // Network/stream error — fall through to reconnect (unless the
        // abort was ours, in which case `stopped` is set).
      }
      if (!stopped) scheduleReconnect();
    }

    connect();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller?.abort();
    };
  }, [url]);
}
