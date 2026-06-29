/**
 * prompt.ts — system prompt builder and credential setup.
 *
 * Composes the general-agent system prompt by concatenating
 * SYSTEM.md (universal guidelines) + TOOLS.md (runtime tool catalog) +
 * GENERAL_AGENT.md (operator-branded persona), then renders team
 * data and member list. Writes Claude setup tokens to per-session HOME.
 *
 * Placeholder substitution: `{{agent_name}}` and `{{app_url}}` are read
 * from `AGENT_NAME` / `APP_URL` env vars set by CDK from cfg.agentName
 * and cfg.appDomain. Self-hosted operators set their own brand.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Paths to the system prompt fragments at /app/system_context/.
 * In the container, compiled JS lives at /app/chat-server/prompt.js,
 * so dirname(__dirname) = /app. */
const SYSTEM_DIR = join(dirname(__dirname), "system_context");
const SYSTEM_PATH = join(SYSTEM_DIR, "SYSTEM.md");
const TOOLS_PATH = join(SYSTEM_DIR, "TOOLS.md");
const GENERAL_AGENT_PATH = join(SYSTEM_DIR, "GENERAL_AGENT.md");

export interface Member {
  userId?: string;
  role?: string;
  telegramUserId?: string;
  telegramUsername?: string;
}

/**
 * Write a long-lived Claude setup token to $HOME/.claude/.credentials.json.
 *
 * Only `sk-ant-oat...` setup tokens are supported. These don't expire
 * and don't need refresh — safe to write fresh into per-session HOME.
 */
export function setupClaudeCredentials(token: string, home?: string): void {
  if (process.env.SKIP_CLAUDE_CREDS_SETUP === "1") return;

  if (!token.startsWith("sk-ant-oat")) {
    throw new Error(
      "Invalid Claude token format: expected a long-lived setup token " +
        "starting with 'sk-ant-oat'. Run `claude setup-token` on the " +
        "admin's host and update the workspace secret.",
    );
  }

  const credsDir = join(home ?? homedir(), ".claude");
  mkdirSync(credsDir, { recursive: true });

  const creds = {
    claudeAiOauth: {
      accessToken: token,
      expiresAt: 9999999999999,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "pro",
    },
  };

  writeFileSync(join(credsDir, ".credentials.json"), JSON.stringify(creds));
}

/**
 * Build the resolved system prompt from template and team data.
 *
 * Identity is derived entirely from the unified member list. Each row
 * carries a Cognito sub and an optional telegramUserId.
 */
export function buildSystemPrompt(opts: {
  teamName: string;
  members: Member[];
  /** Operator's brand name for the agent persona. Substituted for
   *  `{{agent_name}}` in GENERAL_AGENT.md. Read by callers from
   *  `process.env.AGENT_NAME`. */
  agentName: string;
  /** Operator's web frontend URL (e.g. `https://app.example.com`).
   *  Substituted for `{{app_url}}` in GENERAL_AGENT.md. Read by callers
   *  from `process.env.APP_URL`. */
  appUrl: string;
}): string {
  let template: string;
  try {
    const system = readFileSync(SYSTEM_PATH, "utf-8");
    const tools = readFileSync(TOOLS_PATH, "utf-8");
    const general = readFileSync(GENERAL_AGENT_PATH, "utf-8");
    template = `${system}\n\n${tools}\n\n${general}`;
  } catch (err) {
    // Re-throw as a clear error — this is fatal for the turn, and the
    // wrapping turn logger will pick up the cause.
    throw new Error(
      `System prompt fragments not found under ${SYSTEM_DIR}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }

  const { teamName, members, agentName, appUrl } = opts;

  // Render unified member list.
  const membersLines: string[] = [];
  const telegramAdminIds: string[] = [];
  const telegramMemberIds: string[] = [];

  for (const m of members) {
    const role = m.role ?? "member";
    const userId = m.userId ?? "unknown";
    const tg = m.telegramUserId ?? "";
    const tgName = m.telegramUsername ?? "";
    const tgPart = tg ? `, telegram_id=\`${tg}\`` : ", telegram_id=_(unlinked)_";
    const namePart = tgName ? ` @${tgName}` : "";
    membersLines.push(`- Cognito sub \`${userId}\` -- ${role}${tgPart}${namePart}`);
    if (tg) {
      if (role === "admin") telegramAdminIds.push(tg);
      else telegramMemberIds.push(tg);
    }
  }

  const membersContext = membersLines.length > 0 ? membersLines.join("\n") : "_No members configured._";
  const adminTgDisplay =
    telegramAdminIds.length > 0
      ? telegramAdminIds.map((t) => `\`${t}\``).join(", ")
      : "_(unset)_";
  const tgMembersDisplay =
    telegramMemberIds.length > 0
      ? telegramMemberIds.map((t) => `\`${t}\``).join(", ")
      : "_(none)_";

  const prompt = template
    .replace(/\{\{team_name\}\}/g, teamName)
    .replace(/\{\{agent_name\}\}/g, agentName)
    .replace(/\{\{app_url\}\}/g, appUrl)
    .replace(/\{\{admin_telegram_id\}\}/g, adminTgDisplay)
    .replace(/\{\{member_telegram_ids\}\}/g, tgMembersDisplay)
    .replace(/\{\{members_context\}\}/g, membersContext);

  return prompt;
}
