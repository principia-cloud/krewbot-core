import { useCallback, useRef, useState } from 'react';
import { getToken } from '@/auth/cognito';

export interface SSEEvent {
  event: string;
  data: unknown;
}

interface UseSSEReturn {
  events: SSEEvent[];
  isStreaming: boolean;
  error: string | null;
  startStream: (sessionId: string, requestId: string, replay?: boolean) => void;
  stopStream: () => void;
}

/** Default builder — /api/sessions/{id}/chat/stream. `replay=false` is
 * appended for reconnects (page refresh) so the server skips replaying the
 * buffered events the client already has from the loaded transcript. */
const DEFAULT_STREAM_PATH = (
  sessionId: string,
  requestId: string,
  replay = true,
) =>
  `/api/sessions/${sessionId}/chat/stream?requestId=${requestId}${
    replay ? '' : '&replay=false'
  }`;

/**
 * SSE streaming hook for workspace chat.
 * Uses fetch + ReadableStream (not EventSource) to pass the Bearer token.
 *
 * `buildPath` is optional — the first positional arg to `startStream`
 * is still called `sessionId` for backwards compatibility with the main
 * chat UI, but callers with a different URL shape (e.g. the creator
 * view's `/api/agents/{agentId}/creator/chat/stream`) can pass their
 * own builder. The builder receives whatever the caller passes as the
 * first arg, so the name is purely by convention.
 */
export function useSSE(
  baseUrl: string,
  buildPath: (id: string, requestId: string, replay?: boolean) => string = DEFAULT_STREAM_PATH,
): UseSSEReturn {
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const stopStream = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
  }, []);

  const startStream = useCallback(
    (sessionId: string, requestId: string, replay = true) => {
      stopStream();
      setEvents([]);
      setError(null);
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      const token = getToken();
      if (!token) {
        setError('Not authenticated');
        setIsStreaming(false);
        return;
      }

      fetch(`${baseUrl}${buildPath(sessionId, requestId, replay)}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(body.error || `Stream failed: ${res.status}`);
          }

          const reader = res.body?.getReader();
          if (!reader) throw new Error('No response body');

          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            let currentEvent = 'message';

            for (const line of lines) {
              if (line.startsWith('event: ')) {
                currentEvent = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                const rawData = line.slice(6);
                try {
                  const data = JSON.parse(rawData);
                  const evt: SSEEvent = { event: currentEvent, data };
                  setEvents((prev) => [...prev, evt]);

                  if (currentEvent === 'done' || currentEvent === 'error') {
                    setIsStreaming(false);
                    reader.cancel();
                    return;
                  }
                } catch {
                  // Non-JSON data line — skip
                }
                currentEvent = 'message';
              }
            }
          }
          setIsStreaming(false);
        })
        .catch((err) => {
          if (err.name !== 'AbortError') {
            setError(err.message);
          }
          setIsStreaming(false);
        });
    },
    [baseUrl, buildPath, stopStream],
  );

  return { events, isStreaming, error, startStream, stopStream };
}
