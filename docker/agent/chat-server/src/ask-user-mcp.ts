/**
 * ask-user-mcp.ts — in-process MCP that lets the model ask the user a
 * structured multiple-choice question and wait for an answer.
 *
 * Why this exists
 * ---------------
 * The Claude Agent SDK ships a built-in `AskUserQuestion` whose
 * answer-return contract is fulfilled by the CLI's interactive prompt.
 * Our chat-server is headless — it streams events to a browser — so
 * the SDK auto-resolves the built-in with an empty answer the moment
 * it's invoked. The user sees the question card but no picker, and
 * the model gets back garbage.
 *
 * Fix: disable the built-in (see `disallowedTools`) and register this
 * MCP for HTTP sessions only. The tool blocks until the browser POSTs
 * an answer to `/api/sessions/:id/answer-question`, then returns the
 * answer as the tool result so the model continues normally.
 *
 * Adapter sessions (Telegram/Slack/etc.) do NOT get this tool — the
 * model is expected to ask in plain text there, and the user replies
 * in their messaging app, which arrives as the next turn.
 *
 * Single in-flight question per session: the answer endpoint matches
 * by sessionKey alone. Concurrent calls from the same session are
 * rejected (model is told to wait).
 */
import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { rootLogger } from "./logger.js";

export interface AskUserAnswerSelection {
  /** Header of the question this answers — mirrors the request so the
   * model can correlate when multiple questions were asked at once. */
  header: string;
  /** Labels of the options the user picked. Always at least one;
   * length > 1 only when the question's `multiSelect` was true. */
  labels: string[];
}

export interface AskUserAnswer {
  /** One entry per question in the original `questions` array, in
   * request order. */
  answers: AskUserAnswerSelection[];
}

interface PendingQuestion {
  resolve: (answer: AskUserAnswer) => void;
  reject: (err: Error) => void;
}

const pending = new Map<string, PendingQuestion>();

/** Resolve the current pending question for `sessionKey`. Returns
 * true on success, false if there's nothing to resolve. */
export function answerPendingQuestion(
  sessionKey: string,
  answer: AskUserAnswer,
): boolean {
  const entry = pending.get(sessionKey);
  if (!entry) return false;
  pending.delete(sessionKey);
  entry.resolve(answer);
  return true;
}

/** Cancel any pending question for `sessionKey` — used when a turn
 * ends (timeout, abort, container shutdown) so dangling Promises
 * don't leak across turns. Safe to call when nothing is pending. */
export function cancelPendingQuestion(sessionKey: string, reason: string): void {
  const entry = pending.get(sessionKey);
  if (!entry) return;
  pending.delete(sessionKey);
  entry.reject(new Error(reason));
}

/** Whether a question is currently pending for this session. The
 * frontend can poll/derive this from the message stream, but server
 * code reuses it for liveness checks. */
export function hasPendingQuestion(sessionKey: string): boolean {
  return pending.has(sessionKey);
}

export function buildAskUserMcp(opts: { sessionKey: string }) {
  return createSdkMcpServer({
    name: "ask_user",
    version: "1.0.0",
    tools: [
      tool(
        "ask_user_question",
        "Ask the user a multiple-choice question and wait for their answer. Use when you need explicit input from the user before continuing — they'll see clickable options inline in the chat. Prefer this over asking in plain text whenever the answer is one of a small set of known options. The call blocks until the user picks; do NOT call other tools in parallel with this one.",
        {
          questions: z
            .array(
              z.object({
                question: z
                  .string()
                  .describe("The full question shown to the user."),
                header: z
                  .string()
                  .describe("Short label (1–4 words) shown above the picker."),
                multiSelect: z
                  .boolean()
                  .default(false)
                  .describe("Whether the user can pick more than one option."),
                options: z
                  .array(
                    z.object({
                      label: z
                        .string()
                        .describe("Short display label for the option."),
                      description: z
                        .string()
                        .describe(
                          "One-sentence explanation of what choosing this means.",
                        ),
                    }),
                  )
                  .min(1)
                  .describe("The list of selectable options."),
              }),
            )
            .min(1)
            .describe(
              "One or more questions to ask. The chat renders one picker per question; the user must answer all of them before the call returns.",
            ),
        },
        async () => {
          if (pending.has(opts.sessionKey)) {
            return {
              content: [
                {
                  type: "text",
                  text: "A previous ask_user_question is still pending for this session. Wait for the user to answer it before asking another.",
                },
              ],
              isError: true,
            };
          }

          const answerPromise = new Promise<AskUserAnswer>((resolve, reject) => {
            pending.set(opts.sessionKey, { resolve, reject });
          });

          rootLogger.info(
            { event: "ask_user.pending", sessionKey: opts.sessionKey },
            "ask_user_question awaiting answer",
          );

          try {
            const answer = await answerPromise;
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(answer),
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: `Question cancelled: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
