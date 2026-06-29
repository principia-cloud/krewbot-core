/**
 * agent-chat.tsx — shared chat UI used by both the workspace chat
 * (chat-panel.tsx) and the creator chat (agent-creator-view.tsx).
 *
 * Owns: SSE event processing, message rendering (markdown + code
 * highlighting + tool-call groups), scroll-to-bottom, composer
 * keyboard shortcuts, working indicator, stop button.
 *
 * Does NOT own transport. Callers pass a `ChatTransport` that
 * encapsulates the session identity + URL shape + send/cancel/history
 * endpoints. That's the only knob — everything visual is the same.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Send,
  Loader2,
  ArrowDown,
  MessageSquare,
  ChevronRight,
  Square,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Button } from '@/components/ui/button';
import { ToolCallCard } from './tool-call-card';
import { useSSE } from '@/hooks/use-sse';
import { useSessionInbox } from '@/hooks/use-session-inbox';
import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/api/workspace-client';

export interface DisplayMessage {
  role: 'user' | 'assistant';
  type: 'text' | 'tool_use' | 'tool_result' | 'stopped';
  content: string;
  toolName?: string;
  toolInput?: unknown;
}

/** Fallback poll interval for the transcript. The per-session inbox
 * (useSessionInbox) delivers background-task replies instantly; this slow
 * poll is just a safety net for the case where the inbox SSE connection
 * is blocked (e.g. a buffering proxy) and never establishes. */
const HISTORY_POLL_MS = 20_000;

/** Cheap guard so an unchanged poll result doesn't re-render the whole
 * transcript. Compares count + the last message's shape, which is enough
 * to notice a newly-appended bg reply or a freshly-flushed turn. */
function historyChanged(prev: DisplayMessage[], next: DisplayMessage[]): boolean {
  if (prev.length !== next.length) return true;
  const a = prev[prev.length - 1];
  const b = next[next.length - 1];
  if (!a || !b) return false;
  return a.role !== b.role || a.type !== b.type || a.content !== b.content;
}

/** Transport surface. Callers build one for their HTTP flavour
 * (regular workspace chat vs creator chat). `sessionKey` is opaque —
 * only the transport interprets it; the UI threads it through useSSE
 * + the send/cancel callbacks unchanged. */
export interface ChatTransport {
  /** Base URL used by useSSE when opening the stream. */
  baseUrl: string;
  /** Opaque identifier — could be an http session id, an agentId, or
   * anything else the transport cares about. */
  sessionKey: string;
  /** Submit a user message. Returns a requestId that's passed into
   * the stream URL so the server can correlate the SSE stream with
   * the inflight turn. */
  send(message: string): Promise<{ requestId: string }>;
  /** Cancel an in-flight turn. Best-effort — UI still tears down the
   * SSE stream regardless of the return. */
  cancel(requestId: string): Promise<void>;
  /** Optional: load past messages on mount. When omitted, the chat
   * starts empty (fine for stateless or short-lived conversations). */
  loadHistory?(): Promise<ChatMessage[]>;
  /** Build the SSE URL path (appended to baseUrl). Defaults to
   * `/api/sessions/{sessionKey}/chat/stream?requestId=...` — the
   * regular workspace shape. Override for creator (`/api/agents/...`).
   * `replay=false` is passed on reconnect (page refresh). */
  buildStreamPath?(sessionKey: string, requestId: string, replay?: boolean): string;
  /** Optional: on mount, resolve the requestId of a turn already running
   * in this session (or null). Lets the UI reconnect to the live stream
   * after a page refresh instead of showing a stalled, frozen transcript.
   * Only HTTP-session transports implement it; creator/adapter omit. */
  getActiveRequestId?(): Promise<string | null>;
  /** Optional: build the per-session inbox SSE path (appended to baseUrl)
   * for out-of-band server pushes (background-task replies, file changes).
   * Only regular workspace sessions support it; creator/adapter transports
   * omit it and fall back to the periodic poll. */
  inboxStreamPath?(sessionKey: string): string;
  /** Optional: resolve an in-flight `ask_user_question` tool call. Only
   * defined on HTTP-session transports (creator/adapter sessions don't
   * surface the MCP tool). The picker UI calls this when the user
   * submits their selection. */
  answerQuestion?(answer: AskUserAnswer): Promise<void>;
}

/** Shape the `ask_user_question` MCP tool input takes. Mirrors the
 * Zod schema in `chat-server/src/ask-user-mcp.ts`. */
export interface AskUserInput {
  questions: Array<{
    question: string;
    header: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description: string }>;
  }>;
}

/** Mirror of AskUserAnswer in chat-server/src/ask-user-mcp.ts. */
export interface AskUserAnswer {
  answers: Array<{ header: string; labels: string[] }>;
}

/** Tool name string the SDK uses for this MCP. The format is
 * `mcp__{server}__{tool}`. Centralised so the picker detection and
 * any future additions stay in sync. */
export const ASK_USER_TOOL_NAME = 'mcp__ask_user__ask_user_question';

export interface AgentChatProps {
  transport: ChatTransport;
  /** Optional header render slot — e.g., a close button or agent info
   * chip. When omitted, no header is rendered. */
  header?: React.ReactNode;
  /** Optional empty-state hero content (icon + blurb). Rendered above
   * `examplePrompts`. Defaults to a generic prompt. */
  emptyState?: React.ReactNode;
  /** Clickable example prompts shown in the empty state. Clicking one
   * submits it immediately through the transport. */
  examplePrompts?: string[];
  /** Composer placeholder text. */
  placeholder?: string;
  /** Disable the composer and submit button. Useful while loading
   * upstream state (e.g., the creator waits on `getAgent` before it
   * knows which agent to target). */
  disabled?: boolean;
  /** Initial composer text. Set once on mount and any time the value
   * changes (e.g., a parent navigating with a new ?prefill= query
   * string). Useful for the Test button: navigates the user to a
   * fresh chat with a "test the agent like this" prompt staged but
   * unsent so they can edit before submitting. */
  initialInput?: string;
  /** Drag-and-drop hook for `.zip` files. When set, dropping a zip
   * file on the chat panel calls this with the dropped File; the
   * returned promise resolves to a synthetic user message (typically
   * a server-built summary) which the chat then auto-submits as if
   * the user had typed and sent it. Setting this also enables the
   * drop-zone overlay UI. Caller is responsible for uploading the
   * file bytes server-side before resolving. */
  onZipDrop?: (file: File) => Promise<string>;
}

/** Picker rendered inline in the chat for an `ask_user_question` tool
 * call. Replaces the generic ToolCallCard while the call is unresolved
 * — once the tool result lands, ToolCallGroup falls back to the normal
 * card render (collapsed). */
function AskUserPicker({
  input,
  result,
  onAnswer,
}: {
  input: unknown;
  result?: string;
  onAnswer?: (answer: AskUserAnswer) => Promise<void>;
}) {
  // Parse defensively — the input arrives as whatever shape the model
  // produced. If parsing fails, we just dump it as a fallback so the
  // user isn't stuck staring at an unrecoverable card.
  const parsed = input as Partial<AskUserInput> | null;
  const questions = parsed && Array.isArray(parsed.questions) ? parsed.questions : [];

  // Per-question selection: header → set of selected labels.
  const [selections, setSelections] = useState<Record<string, Set<string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const isResolved = result !== undefined;

  const toggle = (q: AskUserInput['questions'][number], label: string) => {
    setSelections((prev) => {
      const cur = new Set(prev[q.header] ?? []);
      if (q.multiSelect) {
        if (cur.has(label)) cur.delete(label);
        else cur.add(label);
      } else {
        cur.clear();
        cur.add(label);
      }
      return { ...prev, [q.header]: cur };
    });
  };

  const allAnswered = questions.every(
    (q) => (selections[q.header]?.size ?? 0) >= 1,
  );

  const submit = async () => {
    if (!onAnswer || submitting || !allAnswered) return;
    setSubmitting(true);
    setError(null);
    try {
      await onAnswer({
        answers: questions.map((q) => ({
          header: q.header,
          labels: Array.from(selections[q.header] ?? []),
        })),
      });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send answer');
    } finally {
      setSubmitting(false);
    }
  };

  // Fallback when input wasn't parseable.
  if (questions.length === 0) {
    return (
      <ToolCallCard
        toolName="ask_user_question"
        input={input}
        result={result}
        status={isResolved ? 'success' : 'running'}
      />
    );
  }

  // Resolved: compact summary chip showing the picked options.
  if (isResolved) {
    let resolvedAnswer: AskUserAnswer | null = null;
    try {
      resolvedAnswer = JSON.parse(result) as AskUserAnswer;
    } catch {
      /* fall through to generic card */
    }
    if (!resolvedAnswer || !Array.isArray(resolvedAnswer.answers)) {
      return (
        <ToolCallCard
          toolName="ask_user_question"
          input={input}
          result={result}
          status="success"
        />
      );
    }
    return (
      <div className="my-1 rounded-md border border-border bg-zinc-50 px-3 py-2 text-xs text-muted-foreground">
        <div className="font-medium text-foreground">You answered</div>
        <div className="mt-1 space-y-0.5">
          {resolvedAnswer.answers.map((a) => (
            <div key={a.header}>
              <span className="text-muted-foreground">{a.header}:</span>{' '}
              <span className="text-foreground">{a.labels.join(', ')}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Unresolved: render interactive picker.
  return (
    <div className="my-2 rounded-lg border border-border bg-white p-3 text-sm">
      {questions.map((q, qi) => (
        <div key={`${q.header}-${qi}`} className={qi > 0 ? 'mt-3 border-t border-border pt-3' : ''}>
          <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {q.header}
            {q.multiSelect && (
              <span className="ml-1 text-muted-foreground/70">· pick one or more</span>
            )}
          </div>
          <div className="mb-2 text-sm text-foreground">{q.question}</div>
          <div className="flex flex-col gap-1.5">
            {q.options.map((opt) => {
              const isSelected = selections[q.header]?.has(opt.label) ?? false;
              return (
                <button
                  key={opt.label}
                  type="button"
                  className={cn(
                    'rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                    isSelected
                      ? 'border-foreground bg-foreground text-white'
                      : 'border-border bg-white hover:border-zinc-300 hover:bg-zinc-50',
                  )}
                  onClick={() => toggle(q, opt.label)}
                  disabled={submitting || submitted}
                >
                  <div className="text-sm font-medium">{opt.label}</div>
                  {opt.description && (
                    <div
                      className={cn(
                        'mt-0.5 text-xs',
                        isSelected ? 'text-white/80' : 'text-muted-foreground',
                      )}
                    >
                      {opt.description}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="mt-3 flex items-center justify-between gap-2">
        {error ? (
          <span className="text-xs text-red-600">{error}</span>
        ) : !onAnswer ? (
          <span className="text-xs text-muted-foreground">
            Picker not available in this session
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {allAnswered ? '' : 'Pick an option to continue'}
          </span>
        )}
        <button
          type="button"
          className={cn(
            'rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50',
          )}
          onClick={submit}
          disabled={!onAnswer || !allAnswered || submitting || submitted}
        >
          {submitting ? 'Sending…' : submitted ? 'Sent' : 'Submit'}
        </button>
      </div>
    </div>
  );
}

/** Groups consecutive tool_use/tool_result pairs into a collapsible summary. */
function ToolCallGroup({
  messages,
  startIndex,
  isStreaming,
  totalMessages,
  onAnswerQuestion,
}: {
  messages: DisplayMessage[];
  startIndex: number;
  isStreaming: boolean;
  totalMessages: number;
  onAnswerQuestion?: (answer: AskUserAnswer) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const pairs: { use: DisplayMessage; result?: DisplayMessage; index: number }[] = [];
  let i = startIndex;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.type === 'tool_use') {
      const next = messages[i + 1];
      pairs.push({
        use: msg,
        result: next?.type === 'tool_result' ? next : undefined,
        index: i,
      });
      i += next?.type === 'tool_result' ? 2 : 1;
    } else {
      break;
    }
  }

  if (pairs.length < 2) {
    const pair = pairs[0];
    if (pair.use.toolName === ASK_USER_TOOL_NAME) {
      return (
        <AskUserPicker
          input={pair.use.toolInput}
          result={pair.result?.content}
          onAnswer={onAnswerQuestion}
        />
      );
    }
    return (
      <ToolCallCard
        toolName={pair.use.toolName || 'unknown'}
        input={pair.use.toolInput}
        result={pair.result?.content}
        status={
          isStreaming && pair.index >= totalMessages - 2 ? 'running' : 'success'
        }
      />
    );
  }

  return (
    <div className="my-1 rounded-md border border-border bg-zinc-50">
      <button
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-zinc-100 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 text-muted-foreground transition-transform',
            expanded && 'rotate-90',
          )}
        />
        <span className="font-mono text-xs text-muted-foreground">
          {pairs.length} tool calls
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border px-2 py-1 space-y-1">
          {pairs.map((pair) => (
            <ToolCallCard
              key={pair.index}
              toolName={pair.use.toolName || 'unknown'}
              input={pair.use.toolInput}
              result={pair.result?.content}
              status={
                isStreaming && pair.index >= totalMessages - 2
                  ? 'running'
                  : 'success'
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function AgentChat({
  transport,
  header,
  emptyState,
  examplePrompts,
  placeholder = 'Ask the agent anything...',
  disabled = false,
  initialInput,
  onZipDrop,
}: AgentChatProps) {
  const { events, isStreaming, error: sseError, startStream, stopStream } =
    useSSE(transport.baseUrl, transport.buildStreamPath);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState(initialInput ?? '');
  const [loading, setLoading] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [stopping, setStopping] = useState(false);
  // Drop-zone state: true while a zip is being uploaded; the count
  // disambiguates dragenter/dragleave on nested children (counter
  // pattern, simpler than tracking targets).
  const [dragDepth, setDragDepth] = useState(0);
  const [uploading, setUploading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const autoScrollRef = useRef(true);
  const activeRequestIdRef = useRef<string | null>(null);
  // True when the current stream is a reconnect to a turn that was already
  // running on mount (page refresh). On `done` we reload history so the
  // canonical transcript replaces the replay=false partial we streamed.
  const reconnectedRef = useRef(false);

  // Load existing messages on session change, then reconnect to any turn
  // still running in this session (e.g. after a page refresh) so live
  // output keeps flowing instead of freezing on a stale transcript.
  useEffect(() => {
    reconnectedRef.current = false;
    if (!transport.loadHistory) {
      setMessages([]);
      return;
    }
    setLoading(true);
    let cancelled = false;
    transport
      .loadHistory()
      .then((msgs) => {
        if (cancelled) return;
        setMessages(msgs as DisplayMessage[]);
        // Reconnect to an in-flight turn, if one exists. replay=false:
        // history already has everything persisted so far, so we only want
        // events from here on — replaying the buffer would duplicate it.
        if (transport.getActiveRequestId) {
          transport
            .getActiveRequestId()
            .then((requestId) => {
              if (cancelled || !requestId) return;
              activeRequestIdRef.current = requestId;
              reconnectedRef.current = true;
              startStream(transport.sessionKey, requestId, false);
            })
            .catch(() => {
              /* best-effort: no reconnect, transcript still shows */
            });
        }
      })
      .catch(() => setMessages([]))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [transport, startStream]);

  // Poll the transcript while idle so a background-task reply that lands
  // after the spawning turn's SSE stream closed shows up on its own. Skip
  // while streaming (live events arrive via SSE and aren't in the
  // transcript yet — refetching would clobber the in-flight partial) and
  // while the tab is hidden (no point polling a backgrounded session).
  useEffect(() => {
    if (!transport.loadHistory) return;
    const timer = setInterval(() => {
      if (isStreaming || document.hidden || !transport.loadHistory) return;
      transport
        .loadHistory()
        .then((msgs) =>
          setMessages((prev) =>
            historyChanged(prev, msgs as DisplayMessage[]) ? (msgs as DisplayMessage[]) : prev,
          ),
        )
        .catch(() => {});
    }, HISTORY_POLL_MS);
    return () => clearInterval(timer);
  }, [transport, isStreaming]);

  // Instant delivery: subscribe to the session inbox so a background-task
  // reply (or an on-(re)connect resync) refetches the transcript the moment
  // it lands, rather than waiting for the fallback poll. Skip the refetch
  // mid-turn — the live partial arrives via the per-turn SSE stream and is
  // not yet in the transcript, so refetching would clobber it.
  const inboxUrl =
    transport.inboxStreamPath
      ? `${transport.baseUrl}${transport.inboxStreamPath(transport.sessionKey)}`
      : null;
  useSessionInbox(inboxUrl, () => {
    if (isStreaming || !transport.loadHistory) return;
    transport
      .loadHistory()
      .then((msgs) =>
        setMessages((prev) =>
          historyChanged(prev, msgs as DisplayMessage[]) ? (msgs as DisplayMessage[]) : prev,
        ),
      )
      .catch(() => {});
  });

  // Apply parent-supplied initialInput when it changes (e.g., the user
  // navigated to ?prefill=... with a fresh starter prompt). Skips
  // the case where the user has typed over it — only seeds an empty
  // composer so we don't trample edits.
  useEffect(() => {
    if (initialInput && !input) {
      setInput(initialInput);
      // Focus the textarea so the user can immediately edit/send.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    // Intentionally not in deps: `input` would re-run after each
    // keystroke. We only want this to fire when the parent supplies
    // a fresh prefill value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialInput]);

  // Incremental SSE event processing. Track last-processed index so
  // re-renders don't reprocess (and startStream resetting events to []
  // rewinds the counter naturally).
  const processedRef = useRef(0);
  useEffect(() => {
    if (events.length === 0) {
      processedRef.current = 0;
      return;
    }
    if (events.length <= processedRef.current) return;

    for (let i = processedRef.current; i < events.length; i++) {
      const evt = events[i];
      if (evt.event === 'message') {
        const data = evt.data as Record<string, unknown>;
        if (data.type === 'text' && typeof data.content === 'string') {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (
              last?.role === 'assistant' &&
              last.type === 'text' &&
              !last.toolName
            ) {
              return [
                ...prev.slice(0, -1),
                { ...last, content: last.content + data.content },
              ];
            }
            return [
              ...prev,
              { role: 'assistant', type: 'text', content: data.content as string },
            ];
          });
        } else if (data.type === 'tool_use') {
          setMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              type: 'tool_use',
              content: `Tool: ${data.name}`,
              toolName: data.name as string,
              toolInput: data.input,
            },
          ]);
        } else if (data.type === 'tool_result') {
          setMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              type: 'tool_result',
              content:
                typeof data.content === 'string'
                  ? data.content
                  : JSON.stringify(data.content),
              toolName: data.tool_use_id as string,
            },
          ]);
        }
      } else if (evt.event === 'done') {
        const data = evt.data as Record<string, unknown>;
        activeRequestIdRef.current = null;
        // After a refresh-reconnect (streamed with replay=false), the live
        // events only covered the tail of the turn. Now that it's done,
        // reload the transcript so the full, canonical turn is shown.
        if (reconnectedRef.current && transport.loadHistory) {
          reconnectedRef.current = false;
          transport
            .loadHistory()
            .then((msgs) => setMessages(msgs as DisplayMessage[]))
            .catch(() => {});
          processedRef.current = events.length;
          break;
        }
        if (data.aborted === true) {
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', type: 'stopped', content: 'Stopped by user' },
          ]);
        } else if (data.error && typeof data.error === 'string') {
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', type: 'text', content: String(data.error) },
          ]);
        } else if (data.reply && typeof data.reply === 'string') {
          // Dedup against any streamed text blocks from this turn —
          // without this, a reply from runAgentTurnImpl's return value
          // would double-render when the assistant also produced text
          // inline.
          setMessages((prev) => {
            let lastUserIdx = -1;
            for (let k = prev.length - 1; k >= 0; k--) {
              if (prev[k].role === 'user') {
                lastUserIdx = k;
                break;
              }
            }
            const turnMessages =
              lastUserIdx >= 0 ? prev.slice(lastUserIdx + 1) : [];
            const turnHasText = turnMessages.some(
              (m) => m.role === 'assistant' && m.type === 'text' && m.content,
            );
            if (!turnHasText) {
              return [
                ...prev,
                {
                  role: 'assistant',
                  type: 'text',
                  content: data.reply as string,
                },
              ];
            }
            return prev;
          });
        }
      } else if (evt.event === 'error') {
        const data = evt.data as Record<string, unknown>;
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            type: 'text',
            content: String(data.error || 'Unknown error'),
          },
        ]);
      }
    }
    processedRef.current = events.length;
  }, [events, transport]);

  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isStreaming]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 60;
    autoScrollRef.current = atBottom;
    setShowScrollButton(!atBottom);
  }, []);

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      autoScrollRef.current = true;
      setShowScrollButton(false);
    }
  };

  const handleSend = async (text?: string) => {
    const msg = (text ?? input).trim();
    if (!msg || isStreaming || disabled) return;
    setInput('');
    setMessages((prev) => [
      ...prev,
      { role: 'user', type: 'text', content: msg },
    ]);
    autoScrollRef.current = true;
    try {
      const { requestId } = await transport.send(msg);
      activeRequestIdRef.current = requestId;
      startStream(transport.sessionKey, requestId);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          type: 'text',
          content: `Error: ${(err as Error).message}`,
        },
      ]);
    }
  };

  const handleStop = async () => {
    if (!activeRequestIdRef.current || stopping) return;
    const requestId = activeRequestIdRef.current;
    setStopping(true);
    try {
      await transport.cancel(requestId);
    } catch {
      // Best-effort — stopStream still fires to tear down the client.
    } finally {
      stopStream();
      activeRequestIdRef.current = null;
      setStopping(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // ----- Drag & drop for .zip uploads -----
  const dropEnabled = !!onZipDrop && !disabled;

  const handleDragEnter = (e: React.DragEvent) => {
    if (!dropEnabled) return;
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    setDragDepth((d) => d + 1);
  };
  const handleDragOver = (e: React.DragEvent) => {
    if (!dropEnabled) return;
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const handleDragLeave = (e: React.DragEvent) => {
    if (!dropEnabled) return;
    e.preventDefault();
    setDragDepth((d) => Math.max(0, d - 1));
  };
  const handleDrop = async (e: React.DragEvent) => {
    if (!dropEnabled || !onZipDrop) return;
    e.preventDefault();
    setDragDepth(0);
    const file = Array.from(e.dataTransfer.files).find((f) =>
      f.name.toLowerCase().endsWith('.zip'),
    );
    if (!file) {
      // Surface a soft error in chat rather than a popup.
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          type: 'text',
          content: 'Drop a `.zip` file to upload it into `def-draft/`.',
        },
      ]);
      return;
    }
    setUploading(true);
    try {
      const summary = await onZipDrop(file);
      // The summary becomes a user message — the creator AI sees it
      // as input describing the uploaded files. No need for a
      // separate "system note" — the synthetic user message is
      // both the visible chat entry and the model's input.
      await handleSend(summary);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          type: 'text',
          content: `Upload failed: ${(err as Error).message}`,
        },
      ]);
    } finally {
      setUploading(false);
    }
  };

  const renderMessages = () => {
    const elements: React.ReactNode[] = [];
    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];
      if (msg.type === 'tool_use') {
        let j = i;
        while (j < messages.length && messages[j].type === 'tool_use') {
          j += messages[j + 1]?.type === 'tool_result' ? 2 : 1;
        }
        elements.push(
          <ToolCallGroup
            key={`tg-${i}`}
            messages={messages}
            startIndex={i}
            isStreaming={isStreaming}
            totalMessages={messages.length}
            onAnswerQuestion={transport.answerQuestion}
          />,
        );
        i = j;
        continue;
      }
      if (msg.type === 'tool_result') {
        i++;
        continue;
      }
      if (msg.type === 'stopped') {
        elements.push(
          <div
            key={i}
            className="my-1 flex items-center gap-2 text-[11px] text-muted-foreground"
          >
            <div className="h-px flex-1 bg-border" />
            <span className="shrink-0">Stopped by user</span>
            <div className="h-px flex-1 bg-border" />
          </div>,
        );
        i++;
        continue;
      }
      // Skip whitespace-only assistant text. Some models (e.g. Kimi via
      // the gateway) emit empty text blocks alongside tool_use blocks,
      // which otherwise render as empty speech bubbles between tool cards.
      if (
        msg.role === 'assistant' &&
        msg.type === 'text' &&
        !msg.content.trim()
      ) {
        i++;
        continue;
      }
      elements.push(
        <div
          key={i}
          className={msg.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
        >
          <div
            className={
              msg.role === 'user'
                ? 'max-w-[85%] rounded-lg bg-[#0c1d36] text-white px-3 py-2 text-sm break-words overflow-hidden'
                : 'max-w-[85%] rounded-lg bg-white border border-border px-3 py-2 text-sm break-words overflow-hidden'
            }
          >
            {msg.role === 'assistant' ? (
              <div className="prose prose-sm max-w-none break-words [&_a]:break-all">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    code({ className, children, ...props }) {
                      const match = /language-(\w+)/.exec(className || '');
                      const codeString = String(children).replace(/\n$/, '');
                      const isBlock = match || codeString.includes('\n');
                      if (isBlock) {
                        return (
                          <SyntaxHighlighter
                            style={oneLight}
                            language={match ? match[1] : 'text'}
                            PreTag="div"
                            customStyle={{
                              margin: 0,
                              borderRadius: '0.375rem',
                              fontSize: '0.8125rem',
                            }}
                          >
                            {codeString}
                          </SyntaxHighlighter>
                        );
                      }
                      return (
                        <code
                          className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs"
                          {...props}
                        >
                          {children}
                        </code>
                      );
                    },
                    pre({ children }) {
                      return <>{children}</>;
                    },
                    // Tables are commonly wider than the chat bubble.
                    // Wrap them in a horizontally scrollable container
                    // so they don't get clipped by the bubble's
                    // overflow-hidden. Compact font + tight padding so
                    // a typical 4-column table still fits inline.
                    table({ children, ...props }) {
                      return (
                        <div className="-mx-2 overflow-x-auto">
                          <table
                            className="min-w-full text-xs [&_th]:bg-zinc-50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium [&_td]:px-2 [&_td]:py-1 [&_td]:align-top [&_td]:border-t [&_td]:border-zinc-200"
                            {...props}
                          >
                            {children}
                          </table>
                        </div>
                      );
                    },
                  }}
                >
                  {msg.content}
                </ReactMarkdown>
              </div>
            ) : (
              <p className="whitespace-pre-wrap">{msg.content}</p>
            )}
          </div>
        </div>,
      );
      i++;
    }
    return elements;
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const showEmpty = messages.length === 0 && !isStreaming;

  return (
    <div
      className="relative flex h-full w-full min-w-0 flex-col"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dropEnabled && (dragDepth > 0 || uploading) && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-violet-50/80 backdrop-blur-sm">
          <div className="rounded-lg border-2 border-dashed border-violet-400 bg-white px-6 py-4 text-sm font-medium text-violet-700 shadow-sm">
            {uploading ? 'Uploading & extracting…' : 'Drop a .zip to extract into def-draft/'}
          </div>
        </div>
      )}
      {header}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-4"
        onScroll={handleScroll}
      >
        {showEmpty && (
          <div className="flex h-full flex-col items-center justify-center gap-4">
            {emptyState ?? (
              <>
                <MessageSquare className="h-10 w-10 text-muted-foreground opacity-30" />
                <p className="text-sm text-muted-foreground">
                  Start a conversation
                </p>
              </>
            )}
            {examplePrompts && examplePrompts.length > 0 && (
              <div className="flex flex-col gap-2">
                {examplePrompts.map((prompt) => (
                  <button
                    key={prompt}
                    className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-zinc-100 hover:text-foreground transition-colors text-left"
                    onClick={() => handleSend(prompt)}
                    disabled={disabled || isStreaming}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="space-y-3">
          {renderMessages()}
          {isStreaming &&
            messages[messages.length - 1]?.role !== 'assistant' && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-lg bg-zinc-50 px-3 py-2">
                  <Loader2 className="h-4 w-4 animate-spin text-accent" />
                  <span className="text-sm text-muted-foreground">
                    Working on it...
                  </span>
                </div>
              </div>
            )}
        </div>
      </div>

      {showScrollButton && (
        <div className="flex justify-center -mt-10 relative z-10">
          <Button
            variant="secondary"
            size="sm"
            className="rounded-full shadow-lg bg-white"
            onClick={scrollToBottom}
          >
            <ArrowDown className="h-3.5 w-3.5" />
            Jump to latest
          </Button>
        </div>
      )}

      {sseError && (
        <div className="mx-3 mb-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {sseError}
        </div>
      )}

      <div className="border-t border-border bg-white p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            className="flex-1 resize-none rounded-lg border border-border bg-white px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-accent focus:outline-none"
            placeholder={placeholder}
            rows={1}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
            }}
            onKeyDown={handleKeyDown}
            disabled={isStreaming || disabled}
          />
          {isStreaming ? (
            <Button
              size="icon"
              variant="outline"
              onClick={handleStop}
              disabled={stopping}
              title="Stop generating"
            >
              {stopping ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Square className="h-4 w-4 fill-current" />
              )}
            </Button>
          ) : (
            <Button
              size="icon"
              onClick={() => handleSend()}
              disabled={!input.trim() || disabled}
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
        <div className="mt-1.5 flex items-center gap-3 text-[10px] text-muted-foreground">
          <span>
            <kbd className="rounded bg-zinc-100 px-1">Enter</kbd> send
          </span>
          <span>
            <kbd className="rounded bg-zinc-100 px-1">Shift+Enter</kbd> newline
          </span>
        </div>
      </div>
    </div>
  );
}
