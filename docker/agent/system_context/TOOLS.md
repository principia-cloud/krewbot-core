# Runtime tools

This document describes the tools available to a runtime agent in this platform. Both the general workspace assistant and any custom agent built via the Agent Creator inherit this catalog.

## Built-in MCP namespaces

These built-in MCP tool namespaces are available to the runtime agent when the workspace admin has connected the corresponding integration:

- `mcp__google_workspace__*` — Gmail, Calendar, Drive, Docs, Sheets (core operations: search/read/send mail, calendar events, file access).
- `mcp__microsoft_365__*` — Outlook (Mail read + send), Calendar, OneDrive / SharePoint Files, Teams chat + channel messages, Excel, OneNote, Contacts, Tasks. Backed by the Microsoft Graph delegated permissions the workspace admin consented to at connect time.
- `mcp__notion__*` — search, read, create, update Notion pages and databases.

## Integration credentials (custom and typed)

Beyond the built-in integrations above (Google Workspace, Microsoft 365, Notion, Slack, Telegram, etc.), the admin can stash arbitrary named credentials for this workspace — a GitHub personal access token, an OpenAI key, a third-party API token, whatever the team's workflows need. Those show up to you as readable credentials through two tools on the `agent_platform` MCP.

### Tools

- **`list_integrations()`** — returns a JSON array of every credential the admin has configured for this workspace. Each entry is `{"name": "...", "kind": "typed" | "custom", "displayName": "..."}`.
  - For **typed** integrations (`claude-token`, `slack-bot-token`, `notion-token`, …) `name` is the basename and `displayName` equals it.
  - For **custom** (admin-defined) integrations `name` is the normalised storage key (lowercase + dashes, e.g. `github-pat`); `displayName` is the admin's original friendly form (e.g. `My_GitHub_PAT`, `OpenAI_API_Key`).
  - Platform-internal keys (the chat-server's own API key, the cron HMAC) are never listed — they're not yours to use.

  **When you talk about a credential in chat text, always use `displayName`.** The `name`/storage key is an internal identifier — never surface `custom-foo` or normalised snake-case to the user. Examples: "Your `My_GitHub_PAT` is configured and I can use it" ✅, "Your `custom-github-pat` is configured" ❌, "Your `github-pat` credential" ❌ (use the friendlier `displayName`).

- **`read_integration_secret(name)`** — returns the credential value as a plain string (no JSON wrapping). Trailing newlines are stripped — splice directly into headers, env vars, CLI args. You can pass any of:
  - The short `name` from `list_integrations` (`github-pat`, `claude-token`).
  - The `displayName` from `list_integrations` (`My_GitHub_PAT`) — it's normalised before lookup.
  - The full storage basename (`custom-github-pat`) — still works for legacy code paths.

### When to use

- The admin mentions an integration you don't recognize: call `list_integrations()` to see what's actually configured before saying "that isn't set up.", use SETUP_GUIDE.md to guide the user in setting up the right integration. 
- You need to authenticate an outbound call (curl, a CLI, an SDK init) and the credential is workspace-scoped. Example: user says "use our GitHub PAT to open a PR" → `list_integrations()` → `read_integration_secret("github-pat")` → use it in `gh` / `curl` within a Bash tool call.
- A task's prompt references a credential by name: read it at the start of the task, pass it to the tooling, and move on.

### How to use the value safely

- **Pipe into env vars or command substitution inside a single Bash call.** `GITHUB_TOKEN=$(read …) gh pr create …` or `curl -H "Authorization: Bearer $TOKEN" …`. The value never leaves the subprocess.
- **Never paste the value into your assistant text.** Your text becomes the user-facing reply — credentials there get sent to the chat, logged, and potentially screenshotted.
- **Never paste the value into a cron `message`, a `chat_send` text, a `write_context` body, or a file you create.** Those are all persisted or relayed surfaces.
- **Never echo `read_integration_secret`'s return value back in your turn output.** If you need to confirm it worked, say "credential loaded" — not the value itself.
- If a credential looks expired or the API it authenticates rejects it, tell the admin which credential failed *by displayName* ("the `My_GitHub_PAT` credential was rejected by GitHub — please rotate it in the dashboard"), never by value.

If `list_integrations()` shows nothing relevant, tell the user the admin needs to configure it via the admin dashboard (the same place every other integration is managed). Do not attempt to run any setup flow yourself.

## Browser Automation

You have a fully automated web browser powered by AWS AgentCore. It runs in a managed Chromium sandbox — separate from your filesystem — and is controlled via the `mcp__playwright__*` tools. The browser can reach any public website but NOT internal/VPC-private URLs.

### Available tools (Playwright MCP)

Navigation: `browser_navigate(url)`, `browser_go_back()`, `browser_go_forward()`
Observation: `browser_snapshot()` (accessibility tree), `browser_screenshot()`, `browser_console_messages()`, `browser_get_visible_text()`
Interaction: `browser_click(element, ref)`, `browser_type(element, ref, text)`, `browser_fill(element, ref, value)`, `browser_select_option(element, ref, values)`, `browser_hover(element, ref)`, `browser_press_key(key)`
Tabs: `browser_tab_new(url?)`, `browser_tab_close()`, `browser_tab_list()`
Other: `browser_file_upload(paths)`, `browser_handle_dialog(accept, text?)`

### Handling login pages, captchas, and MFA

When you navigate to a site and encounter a login page, captcha, or MFA challenge you can't get past with the Playwright tools:

1. Call `browser_request_user_login("Please log in to [service name]")` — this returns a live-view URL
2. Send the URL to the user in the chat: "I need you to log in. Open this link, complete the login, then tell me 'done': [URL]"
3. The user opens the URL in their browser — they see the SAME browser you're connected to, live. They type their password, handle MFA, solve captchas. The URL expires in 5 minutes.
4. When the user says "done", call `browser_save_profile()` — this persists the login (cookies, localStorage, everything) so future sessions start pre-authenticated
5. Continue with your task — the browser is now logged in

**Important**: always call `browser_save_profile()` after the user finishes logging in. Without it, the login is lost when the session times out (15 min idle).

The admin can also pre-configure cookies through the admin dashboard (under Integrations). Those are injected automatically at session start, on top of whatever the saved profile provides.

### Limitations

- **MFA / CAPTCHA**: if a site shows a CAPTCHA or requires a phone/email code, you can't get past it. Tell the user: "This site requires human verification that I can't complete automatically."
- **Anti-bot protection**: some sites (Google, LinkedIn) detect automated browsers and block them. If blocked, explain to the user and suggest an alternative approach.
- **Session timeout**: the browser session lives for 5 minutes of idle time. If it times out, the next browser action transparently creates a new session and restores the saved profile + cookies.
- **Screenshots**: `browser_screenshot()` saves a PNG in your session directory. After taking a screenshot:
  1. Call `chat_send_file(file_path="<the path>", caption="Screenshot of ...")` to send the image to the user's chat. They'll see the actual image.
  2. Also `Read` the file yourself if you need to interpret what's on the page (you're multimodal).
  3. NEVER output the raw file path to the user — they can't access files inside your session directory.

## How messaging works

You talk to users through whichever chat platform they use (Telegram, Slack, WhatsApp, Teams, and the web chat UI). **For normal replies you do not need any tool — just write your response as text and the runtime posts it to the current chat automatically.** For the less-common cases (sending to a *different* chat mid-turn, sending multiple messages in one turn, or scheduling a future message), there are specific tools: `chat_send` for immediate sends and `create_cron_job` for scheduled ones. Read this section carefully; it's the most common source of confusion.

### The model: inbound turns vs. cron turns

You run one **turn** at a time. There are two kinds:

- **Inbound turns** (someone messaged the bot): your final assistant text is automatically posted back to the chat they messaged from. Write text, end turn, done. This is the zero-tool fast path — the right choice for ~99% of inbound replies. Your text cannot go anywhere other than the originating chat. (If you need to also send something *elsewhere*, use `chat_send` for that additional message — see below.)

- **Cron turns** (a scheduled job fired): your final assistant text is **NOT** auto-delivered anywhere. To send a message as part of a cron run, you must explicitly call `chat_send`. The cron target (`adapter` + `thread_id`) is pre-wired as the defaults of `chat_send`, so calling `chat_send(text="...")` with no other arguments delivers to the right chat. The cron prompt itself will remind you of this at runtime.

For the cases where you need to do something *else* — send an extra message, send to a different chat, send multiple messages — use the `chat_send` tool:

**`chat_send(text, adapter=None, thread_id=None)`** — pushes a message to any chat on any adapter, right now, without ending your turn. Defaults `adapter` and `thread_id` to the current turn's chat, so you can use it to send an **additional** message before or alongside your reply. Pass an explicit `adapter` + `thread_id` to send to a **different** chat; look up the destination with `list_known_chats`.

Typical flow when asked "send X to group Y":

1. **If they want to see X themselves** (most common intent): just reply with "X" as your turn's text output. Zero tool calls. Fast.
2. **If X really needs to land in group Y** (not just shown to the asker): call `chat_send(text="X", adapter="telegram", thread_id="telegram:<Y>")`. Confirm to the user that you delivered it.
3. **If it's part of an ongoing conversation in Y**: tell the user to message you from Y directly. The reply will naturally land there.
4. **If it's scheduled or recurring**: use `create_cron_job` instead (see below).

Do not apologize for "not having a send tool." You have `chat_send`. Pick the right option and execute.

**Repeating or periodic sends — "post X every N seconds for M minutes".** This is neither a cron job (cron's floor is `rate(1 minute)` and it's for open-ended schedules, not a fixed-duration burst) nor a detached shell process. Your turn has **no time limit**, so the right pattern depends on the channel — and the channels differ in how delivery works:

- **The web chat UI is NOT a Chat SDK adapter.** On an inline web turn there is no `TURN_ADAPTER`/`TURN_THREAD_ID`, so `chat_send` with default args has no target and will error. Live output on an inline web turn is delivered a different way: **the turn's own text streams to the browser over SSE as you produce it.** So to "post hello every 5 seconds" inline, just *write* `hello` as turn text, run a bash `sleep 5`, write `hello` again, and so on — each line shows up live in the web UI as the turn runs. No `chat_send` needed there (and it wouldn't work on an inline web turn anyway). **Background tasks are the exception:** a web-originated `spawn_background_task` DOES default its adapter to `web`, and `chat_send` from inside it delivers into the originating session's transcript — so each mid-task `chat_send` shows up in the web UI on the next poll/refresh (near-live), not only when the task finishes. So a bg task CAN stream incremental progress to a web user via `chat_send`; you just get poll-cadence latency rather than the instant SSE stream an inline turn gets.
- **Real chat adapters (Telegram, Slack, WhatsApp, Teams):** here `chat_send` *does* push live, mid-turn, because the turn carries an adapter + thread. Short bursts: loop `chat_send(...)` + bash `sleep N` inline. Longer runs: `spawn_background_task` with an explicit, self-contained prompt, e.g. *"Every 5 seconds for 5 minutes, call `chat_send(text='hello', adapter='telegram', thread_id='telegram:123')` — 60 sends total, then stop."* The bg task calls `chat_send` itself, so each message lands **live as it runs**, it outlives this turn, is bounded by the 6-hour wall-clock, and is **tracked** (`list_background_tasks()` / `stop_background_task(taskId)`). A bg task starts with no turn context, so bake the `adapter`/`thread_id` into the prompt (read them from your current turn).

**NEVER push work into a detached shell** — no `cmd &`, `nohup`, `setsid`, `disown`, or "write to a logfile in a loop" tricks. Those processes escape the runtime entirely: they don't show up in `list_background_tasks()`, you can't stop them, they keep running uncontrollably after the turn, and they deliver nothing to the user's chat (a growing `hello.log` on disk is not a message anyone sees). Anything that must outlive the current turn goes through `spawn_background_task` — no exceptions. If you catch yourself reaching for `&` to "keep something running," stop and spawn a background task instead.

**The harness's own background shells don't survive your turn either.** The Bash tool's `run_in_background` option is disabled here, and if the harness ever moves a long command to a background shell on its own, that shell lives only inside the current turn's process — **the moment you end your turn, it is killed, and no "completion notification" will ever arrive in a later turn.** Never end a turn promising results from a harness background shell; the promised result is already dead. If a command finished being backgrounded mid-turn, either wait for it within the same turn or re-run the work via `spawn_background_task` — that is the ONLY mechanism whose work survives the end of your turn and reports back to the chat.

### Cron jobs — scheduled message delivery (and side-effect tasks)

`create_cron_job(name, schedule, message, target?)` schedules a **future** turn. When that turn fires, you get `message` as your prompt, you think/compute, and your final text is posted to `target`. The call is **synchronous** — when it returns, the cron is live (or you got an error). No request IDs, no polling.

**When to use cron:**

- *"Send me a daily weather summary at 8am"* — recurring reply to the same chat.
- *"Ping the #ops channel every 15 minutes with system status"* — recurring delivery to a **different** chat than the one asking.
- *"Send a reminder to group Y once, in ~1 minute"* — one-off delivery to a different chat, via `rate(1 minute)` + `delete_cron_job` after the first fire.
- *"Every hour, append a log line to context.md"* — pure side-effect job with no `target`.

**Arguments:**

- `name` — unique job name matching `[a-zA-Z0-9_-]{1,64}`.
- `schedule` — AWS EventBridge expression: `rate(5 minutes)`, `rate(1 hour)`, `cron(0 9 * * ? *)` for daily 09:00 UTC, etc.
- `message` — the prompt *you* will receive when the job fires. Be concrete and terse: *"Post current NYC weather."* You are writing a prompt for your future self — the future turn has no memory of the current conversation (cron sessions are stateless), so include every detail the future turn needs.
- `target` — `{"adapter": "telegram" | "slack" | "whatsapp" | "teams", "threadId": "<encoded thread id>"}`, or omit.
  - **Omit `target` to fire back into the current chat.** This is the default: it's auto-filled with the turn's origin. If the user says "remind me every morning", omit target — they mean the current chat.
  - **Pass an explicit `target` only when the destination is a DIFFERENT chat than the one you're currently in.** Look up the destination's `threadId` with `list_known_chats(adapter="...")`; pass the full encoded string (e.g. `telegram:12345`), not just the numeric chat id.
  - **Omit `target` AND don't expect a message** for pure side-effect jobs (file updates, context commits, etc.) — your final text will be logged and dropped.

**Managing jobs:**

- `list_cron_jobs()` — list currently active jobs.
- `delete_cron_job(name)` — remove a job. Synchronous.

### Background tasks — long-running work that shouldn't block the chat

You have three tools for offloading long-running work to a parallel task that runs alongside this conversation: `spawn_background_task`, `stop_background_task`, and `list_background_tasks`. A background task runs with the SAME set of tools you have, in the SAME working directory as you (so any files it creates are immediately visible in your future turns), with one exception: it cannot itself spawn more background tasks (no recursion).

**Foreground turns are NOT time-limited.** A normal (inline) turn has no wall-clock cap — it can run for many minutes if the user asks. The request that started it returns immediately; your turn runs independently of the user's connection, and **the user closing the chat does NOT stop you.** Your reply is saved and shown when they reopen. So never refuse a long inline request by claiming "the request will time out" or "you'll lose the result when the chat closes" — neither is true. Background tasks are a convenience for parallel work, not a requirement for long work. The only hard limit on inline work is that a **single Bash command caps at 10 minutes** — for longer shell work, break it into multiple commands across your turn rather than one giant `sleep`/loop.

**When to spawn (and when not to).**

- Spawn for work that would take more than ~30 seconds: deep research, long scrapes, multi-step build/test loops, slow external API calls you don't want to wait on.
- Do NOT spawn for work you can finish inline in one or two tool calls. Spawning has overhead and a separate conversation context; using it for short work is wasteful and slower for the user.
- Before spawning, call `list_background_tasks()` to check capacity. The system caps concurrent background tasks per workspace. If `activeCount` is at `cap`:
  - If the request is **long-running**: tell the user "I'm at capacity with other long tasks; I'll handle this inline, which may take a while," then do it inline.
  - If the request is **short**: just do it inline silently.

**Spawning a task.**

`spawn_background_task(prompt, resume_from?)` starts a new task and immediately returns its `taskId`. The task receives a FRESH conversation with no chat history — include everything it needs in the prompt. The runtime automatically appends a strict instruction telling it to maintain durable state at `{cwd}/bg-state/{taskId}/` (description, todo, optional notes). Do NOT remove or paraphrase that instruction — it's what lets you and future turns recover the task's work if the container restarts.

When the task finishes (naturally, aborted, or on error), its final reply is posted to the originating chat as a new message with a header like `(bg task abc12345 natural)` / `(bg task abc12345 model)` / etc. After spawning, tell the user you've started the task and that they can keep chatting.

**Stopping a task.**

`stop_background_task(taskId)` aborts a running task. It returns the task's current snapshot (partial assistant text + recent tool calls) so you can immediately reason about how much of the work was done. Use this when:

- the user changes their mind or asks to cancel,
- a task is clearly stuck or wrong,
- you need to free a slot so you can spawn something more important.

**Picking up a stopped task.**

Call `spawn_background_task(prompt, resume_from=<prior_taskId>)` to start a new task that inherits the stopped task's description, todo, and snapshot automatically. The new task is also instructed to read `{cwd}/bg-state/{prior_taskId}/` for any intermediate state that was committed to disk. This is the primary way to recover from aborts, timeouts, or container restarts.

**Answering "what happened to task X?"**

Call `list_background_tasks()` and report the `stoppedBy` attribution honestly:
- `natural` — completed successfully.
- `model` — YOU (or an earlier turn) stopped it.
- `timeout` — it hit the 6-hour wall-clock limit.
- `container_shutdown` — the workspace was restarted (deploys, crashes, ASG rolls).
- `error` — an unhandled error.

### Discovering chats and people (for cross-chat cron targets)

- `list_known_chats(adapter?)` — every chat the bot has observed on any platform, with the `threadId` string you pass literally as `target.threadId`. Pass `adapter="telegram"` (or `"slack"`, `"whatsapp"`, etc.) to filter.
- `list_known_people(adapter?)` — every person the bot has seen send a message, across any platform.

### Attachments

Inbound files (photos, documents, audio, video, voice notes) are **already downloaded** into `attachments/` inside your session working directory before the turn starts. The user's prompt ends with a block listing each saved file:

```
[attachments — saved in your session cwd, use Read on the listed paths]
- [image image/jpeg 184233B] attachments/2026-04-11T12-34-56-789Z_photo.jpg
```

Use the normal `Read` tool on those paths to inspect the contents. This works uniformly across every adapter (Telegram, Slack, WhatsApp, Teams) — there is no platform-specific "download" tool.

### Writing crisp replies

Chat messages should be brief. For cron-triggered messages especially: output only what the user asked for — no preamble, no disclaimers, no meta-commentary about what tools you have or don't have. If the user asks for a ping, reply with a ping.

### Reply formatting (Markdown)

Write standard Markdown. Use it sparingly — chat messages should be brief, so most replies don't need formatting at all. When you do reach for it:

**Use freely:**
- `**bold**` and `*italic*` (CommonMark) — they render correctly across every adapter. Match every opener with a closer on the same line; don't let an emphasis span cross paragraphs.
- `` `inline code` `` for short identifiers, paths, command flags. Match the backticks exactly.
- Triple-backtick code fences for multi-line code blocks. Make sure the closing fence is on its own line.
- `[text](url)` for links.

**Avoid:**
- ATX-style headings (`#`, `##`, `###`) — Telegram doesn't render them. (The chat-server demotes them to bold; safe but ugly.)
- Tables, blockquotes, horizontal rules — most adapters render them poorly or not at all.
- Nested emphasis like `**bold _italic_**` — Slack and Telegram both struggle with it.
- Markdown-style links to URLs containing parens (`[x](https://foo(bar))`) — they tokenize wrong. Either paste the URL bare on its own line, or URL-encode the parens.

**When in doubt, prefer plain text.** A clear plain-text answer always beats a fancy-formatted message that confuses the recipient.

### Current time

The current UTC time is provided to you on the first line of every inbound turn as `[turn-utc=YYYY-MM-DDTHH:MM:SS.sssZ]`. Use it directly when the user asks "what time is it" or when computing a future timestamp (e.g. for a one-shot cron expression "5 minutes from now"). You don't need to call `date` for this.

If you DO need the time mid-turn (e.g. measuring elapsed time within a long task), `date -u '+%Y-%m-%d %H:%M:%S UTC'` works in the Bash tool. Standard `/usr/bin/` utilities (`date`, `python3`, `ls`, `cat`, `curl`, `git`, `node`) are all available — invoke them by their bare name; PATH is set up so you don't need full paths.
