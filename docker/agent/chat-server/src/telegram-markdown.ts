/**
 * telegram-markdown.ts — convert the model's CommonMark output into
 * markdown that Telegram's legacy `parse_mode=Markdown` parser accepts.
 *
 * Why this exists
 * ---------------
 *
 * Chat SDK's Telegram adapter (`@chat-adapter/telegram`) takes the
 * `{markdown: …}` payload, parses it as CommonMark, then re-stringifies
 * to CommonMark (via `stringifyMarkdown`) and ships it to Telegram with
 * `parse_mode: "Markdown"`. CommonMark uses `**bold**` (double
 * asterisk) for strong, but Telegram's legacy Markdown expects
 * `*bold*` (single asterisk). When the model writes any `**…**` the
 * adapter forwards it verbatim and Telegram rejects the message with
 * "can't find end of the entity" — a 100% reproducible failure on any
 * non-trivial markdown reply.
 *
 * The proper fix is in Chat SDK (the adapter should emit Telegram's
 * dialect, not CommonMark). Until that lands upstream, this module is
 * the compensating layer in the chat-server: we pre-translate the
 * model's CommonMark to Telegram's flavor before handing it to the
 * adapter. The adapter still does its parse/stringify round-trip but
 * by then the input is already Telegram-safe.
 *
 * Transformations (outside code spans/fences only)
 * ------------------------------------------------
 *
 *   `**X**`         → `*X*`        CommonMark strong → Telegram bold
 *   `__X__`         → `*X*`        CommonMark alt strong → Telegram bold
 *   `# ` / `## ` /  → `*…*\n`      Telegram doesn't render headings;
 *   `### ` headings                 demote to bold so they read as a
 *                                   visual section break
 *   `*X*`           → unchanged     Will render as italic OR bold on
 *                                   Telegram (legacy is lenient); leaving
 *                                   it alone preserves the model's intent
 *                                   without risking misinterpretation
 *
 * Code spans (`` `…` ``) and triple-backtick fences are passed through
 * untouched so transformations don't corrupt code samples (e.g. a Python
 * docstring containing `**kwargs` would be wrecked by a naive regex).
 */

/** Single entry point. Pure function; no I/O, no global state. */
export function commonMarkToTelegramMarkdown(input: string): string {
  if (!input) return input;

  // Walk the input one segment at a time, alternating between
  // "code" (left untouched) and "non-code" (where we apply
  // transformations). The segmentation is what makes the regex
  // approach safe — without it, transforms inside code samples would
  // mangle the code (e.g. `**kwargs` in a Python signature).
  const segments = splitByCodeRegions(input);
  return segments
    .map((seg) => (seg.kind === "code" ? seg.text : transformOutsideCode(seg.text)))
    .join("");
}

// ---------------------------------------------------------------------------
// Code-region segmentation
// ---------------------------------------------------------------------------

interface Segment {
  kind: "code" | "text";
  text: string;
}

/**
 * Split the input into alternating "code" and "text" segments. A "code"
 * segment is either a triple-backtick fenced block (multi-line) or an
 * inline code span (single backticks). Everything else is "text".
 *
 * Fences take precedence over inline spans (a fence ends only at a
 * matching closing fence on its own line, mirroring CommonMark).
 *
 * Pathological inputs — unmatched triple fences, unmatched single
 * backticks — fall through as plain text. We do NOT try to "fix" them
 * because the model's intent is unrecoverable; better to forward as-is
 * and let Telegram render whatever it can than guess and corrupt.
 */
function splitByCodeRegions(text: string): Segment[] {
  const segments: Segment[] = [];
  let i = 0;
  let pending = "";

  const flushPending = () => {
    if (pending) {
      segments.push({ kind: "text", text: pending });
      pending = "";
    }
  };

  while (i < text.length) {
    // Triple-backtick fence: ``` at the start of a line (or after a newline).
    // We require the fence to be at column 0 of its line because that's the
    // CommonMark rule and matches what models almost always emit.
    if (
      text.startsWith("```", i) &&
      (i === 0 || text[i - 1] === "\n")
    ) {
      // Find the closing fence — also at start of a line.
      const closeStart = findClosingFence(text, i + 3);
      if (closeStart !== -1) {
        // Include everything from the opening fence through the
        // newline after the closing fence (if present).
        const end = closeStart + 3;
        const tail = text[end] === "\n" ? end + 1 : end;
        flushPending();
        segments.push({ kind: "code", text: text.slice(i, tail) });
        i = tail;
        continue;
      }
      // No closing fence — treat as plain text and move on.
    }

    // Inline code span: single backticks on the same line.
    if (text[i] === "`") {
      const close = text.indexOf("`", i + 1);
      // Only recognize a span if the closer is on the SAME line —
      // otherwise it's almost certainly a stray backtick rather than
      // a malformed multi-line span.
      if (close !== -1 && !text.slice(i + 1, close).includes("\n")) {
        flushPending();
        segments.push({ kind: "code", text: text.slice(i, close + 1) });
        i = close + 1;
        continue;
      }
    }

    pending += text[i];
    i++;
  }

  flushPending();
  return segments;
}

/** Find the start index of a closing ``` fence at column 0. */
function findClosingFence(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    if (text.startsWith("```", i) && (i === 0 || text[i - 1] === "\n")) {
      return i;
    }
    i = text.indexOf("\n", i);
    if (i === -1) return -1;
    i++; // step past the newline so the next iteration checks col 0
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Outside-code transformations
// ---------------------------------------------------------------------------

/**
 * Apply every CommonMark→Telegram-Markdown transformation to a chunk
 * of non-code text. The order matters: bold patterns must run BEFORE
 * any italic-touching logic, because `**X**` would otherwise be
 * mis-recognized as `*` + `*X*` + `*`.
 */
function transformOutsideCode(text: string): string {
  let out = text;

  // Strong → bold.
  // Non-greedy `(.+?)` so consecutive `**a** **b**` produces two
  // separate bold spans, not one giant span swallowing the middle.
  // No-newline match so a stray ** doesn't bridge paragraphs.
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, "*$1*");
  out = out.replace(/__([^_\n]+?)__/g, "*$1*");

  // ATX headings. Telegram legacy Markdown has no heading syntax;
  // convert "# Title" / "## Title" / "### Title" to "*Title*" so the
  // structure is preserved as visual emphasis. Multiline `m` flag so
  // `^` and `$` match line boundaries; `[ \t]*` (not `\s*`) so we
  // don't accidentally swallow the trailing newline and merge the
  // heading into the next line.
  out = out.replace(/^[ \t]*(?:#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, "*$1*");

  return out;
}
