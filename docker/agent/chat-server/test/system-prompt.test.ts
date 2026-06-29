/**
 * Asset-level tests for the four system prompt fragments under
 * docker/agent/system_context/. The general-agent loader (prompt.ts)
 * and the creator-agent loader (agent.ts:runCreatorTurnImpl) both
 * compose `SYSTEM.md + TOOLS.md + {GENERAL_AGENT|CREATOR_AGENT}.md`
 * with `\n\n` separators and apply a placeholder substitution
 * ({{team_name}} + {{members_context}} for the general path,
 * {{agentId}} for the creator path).
 *
 * The loaders themselves resolve the fragments via a path that's only
 * valid inside the agent container (/app/system_context/). Rather than
 * invoke the loaders, these tests pin the contract they depend on:
 * the fragments exist at the expected paths, have the expected
 * headings, contain the expected placeholders, and the simulated
 * concatenation produces a well-formed prompt.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// chat-server/test/ → chat-server/ → docker/agent/system_context/
const SYSTEM_CONTEXT_DIR = join(__dirname, "..", "..", "system_context");
const SYSTEM_PATH = join(SYSTEM_CONTEXT_DIR, "SYSTEM.md");
const TOOLS_PATH = join(SYSTEM_CONTEXT_DIR, "TOOLS.md");
const GENERAL_AGENT_PATH = join(SYSTEM_CONTEXT_DIR, "GENERAL_AGENT.md");
const CREATOR_AGENT_PATH = join(SYSTEM_CONTEXT_DIR, "CREATOR_AGENT.md");

const SYSTEM_HEADING = "# General guidelines";
const TOOLS_HEADING = "# Runtime tools";
// Heading line in GENERAL_AGENT.md before placeholder substitution.
// Body uses {{agent_name}} for the persona; the heading rebrands when
// a downstream overlay substitutes AGENT_NAME.
const GENERAL_HEADING_PREFIX = "# {{agent_name}} —";
const CREATOR_HEADING = "# CrewBot Agent Creator";

describe("system_context fragments — asset layout", () => {
  it("SYSTEM.md exists and starts with the universal-guidelines heading", () => {
    assert.ok(existsSync(SYSTEM_PATH), `expected ${SYSTEM_PATH} to exist`);
    const body = readFileSync(SYSTEM_PATH, "utf-8");
    assert.ok(
      body.startsWith(SYSTEM_HEADING),
      `SYSTEM.md should start with "${SYSTEM_HEADING}", got: ${body.slice(0, 50)}`,
    );
  });

  it("TOOLS.md exists and starts with the runtime-tools heading", () => {
    assert.ok(existsSync(TOOLS_PATH), `expected ${TOOLS_PATH} to exist`);
    const body = readFileSync(TOOLS_PATH, "utf-8");
    assert.ok(
      body.startsWith(TOOLS_HEADING),
      `TOOLS.md should start with "${TOOLS_HEADING}", got: ${body.slice(0, 50)}`,
    );
  });

  it("GENERAL_AGENT.md exists, has the {{agent_name}} heading, and carries general-path placeholders", () => {
    assert.ok(existsSync(GENERAL_AGENT_PATH), `expected ${GENERAL_AGENT_PATH} to exist`);
    const body = readFileSync(GENERAL_AGENT_PATH, "utf-8");
    assert.ok(
      body.startsWith(GENERAL_HEADING_PREFIX),
      `GENERAL_AGENT.md should start with "${GENERAL_HEADING_PREFIX}", got: ${body.slice(0, 50)}`,
    );
    assert.ok(
      body.includes("{{team_name}}"),
      "GENERAL_AGENT.md should contain {{team_name}} placeholder for buildSystemPrompt",
    );
    assert.ok(
      body.includes("{{members_context}}"),
      "GENERAL_AGENT.md should contain {{members_context}} placeholder for buildSystemPrompt",
    );
  });

  it("CREATOR_AGENT.md exists, has the creator heading, and carries the {{agentId}} placeholder", () => {
    assert.ok(existsSync(CREATOR_AGENT_PATH), `expected ${CREATOR_AGENT_PATH} to exist`);
    const body = readFileSync(CREATOR_AGENT_PATH, "utf-8");
    assert.ok(
      body.startsWith(CREATOR_HEADING),
      `CREATOR_AGENT.md should start with "${CREATOR_HEADING}", got: ${body.slice(0, 50)}`,
    );
    assert.ok(
      body.includes("{{agentId}}"),
      "CREATOR_AGENT.md should contain {{agentId}} placeholder for runCreatorTurnImpl",
    );
  });

  it("SYSTEM.md and TOOLS.md (shared fragments) carry no template placeholders", () => {
    // Universal/tools content must not need per-turn substitution; if a
    // {{...}} token sneaks in here, the loader won't replace it and
    // it'll surface verbatim in the prompt.
    for (const p of [SYSTEM_PATH, TOOLS_PATH]) {
      const body = readFileSync(p, "utf-8");
      assert.ok(
        !/\{\{[a-zA-Z_]+\}\}/.test(body),
        `${p} should not contain {{...}} placeholders (shared, perspective-neutral)`,
      );
    }
  });
});

describe("system prompt composition — general agent path", () => {
  // Mirrors prompt.ts:buildSystemPrompt: read three fragments, join with
  // `\n\n`, then substitute placeholders. We reproduce the loader's
  // composition rather than invoke it because the loader resolves
  // system_context/ via /app/-relative paths that are container-only.

  function composeGeneral(
    teamName: string,
    membersContext: string,
    agentName = "acmebot",
    appUrl = "https://app.acme.test",
  ): string {
    const system = readFileSync(SYSTEM_PATH, "utf-8");
    const tools = readFileSync(TOOLS_PATH, "utf-8");
    const general = readFileSync(GENERAL_AGENT_PATH, "utf-8");
    const template = `${system}\n\n${tools}\n\n${general}`;
    return template
      .replace(/\{\{team_name\}\}/g, teamName)
      .replace(/\{\{agent_name\}\}/g, agentName)
      .replace(/\{\{app_url\}\}/g, appUrl)
      .replace(/\{\{members_context\}\}/g, membersContext)
      // Telegram placeholders are exercised separately; stub here to
      // satisfy the "no leftover placeholders" assertion.
      .replace(/\{\{admin_telegram_id\}\}/g, "_(unset)_")
      .replace(/\{\{member_telegram_ids\}\}/g, "_(none)_");
  }

  it("produces SYSTEM, TOOLS, GENERAL_AGENT headings in order", () => {
    const out = composeGeneral("Acme", "_No members configured._");
    const systemIdx = out.indexOf(SYSTEM_HEADING);
    const toolsIdx = out.indexOf(TOOLS_HEADING);
    const generalIdx = out.indexOf("# acmebot — Acme");
    assert.notEqual(systemIdx, -1, "SYSTEM heading missing");
    assert.notEqual(toolsIdx, -1, "TOOLS heading missing");
    assert.notEqual(generalIdx, -1, "GENERAL_AGENT heading missing (or substitution failed)");
    assert.ok(
      systemIdx < toolsIdx && toolsIdx < generalIdx,
      `expected order SYSTEM(${systemIdx}) < TOOLS(${toolsIdx}) < GENERAL(${generalIdx})`,
    );
  });

  it("substitutes {{team_name}}, {{agent_name}}, {{app_url}}, {{members_context}} and leaves no leftover placeholders", () => {
    const out = composeGeneral("Acme", "- Cognito sub `u1` -- admin");
    assert.ok(out.includes("# acmebot — Acme"), "{{team_name}} or {{agent_name}} not substituted in heading");
    assert.ok(out.includes("https://app.acme.test"), "{{app_url}} not substituted");
    assert.ok(out.includes("- Cognito sub `u1` -- admin"), "{{members_context}} not substituted");
    assert.ok(
      !out.includes("krewbot"),
      "GENERAL_AGENT.md must not bake in a product brand after substitution",
    );
    assert.ok(
      !/\{\{[a-zA-Z_]+\}\}/.test(out),
      "composed general-agent prompt still contains {{...}} placeholders",
    );
  });

  it("separates the three fragments with exactly one blank line", () => {
    const out = composeGeneral("Acme", "_No members configured._");
    // The loader joins with `\n\n` and each fragment ends with a single
    // newline; we assert TOOLS heading is preceded by a blank line.
    const toolsIdx = out.indexOf(TOOLS_HEADING);
    assert.ok(toolsIdx >= 2, "TOOLS heading should not appear at the very start");
    assert.equal(
      out.slice(toolsIdx - 2, toolsIdx),
      "\n\n",
      "expected a blank line before the TOOLS heading",
    );
    const generalIdx = out.indexOf("# acmebot — Acme");
    assert.equal(
      out.slice(generalIdx - 2, generalIdx),
      "\n\n",
      "expected a blank line before the GENERAL_AGENT heading",
    );
  });
});

describe("system prompt composition — creator agent path", () => {
  // Mirrors agent.ts:runCreatorTurnImpl: read SYSTEM + TOOLS +
  // CREATOR_AGENT, join with `\n\n`, then substitute {{agentId}}.

  function composeCreator(agentId: string): string {
    const system = readFileSync(SYSTEM_PATH, "utf-8");
    const tools = readFileSync(TOOLS_PATH, "utf-8");
    const creator = readFileSync(CREATOR_AGENT_PATH, "utf-8");
    const template = `${system}\n\n${tools}\n\n${creator}`;
    return template.replace(/\{\{agentId\}\}/g, agentId);
  }

  it("produces SYSTEM, TOOLS, CREATOR_AGENT headings in order", () => {
    const out = composeCreator("agt_abc1234567");
    const systemIdx = out.indexOf(SYSTEM_HEADING);
    const toolsIdx = out.indexOf(TOOLS_HEADING);
    const creatorIdx = out.indexOf(CREATOR_HEADING);
    assert.notEqual(systemIdx, -1, "SYSTEM heading missing");
    assert.notEqual(toolsIdx, -1, "TOOLS heading missing");
    assert.notEqual(creatorIdx, -1, "CREATOR_AGENT heading missing");
    assert.ok(
      systemIdx < toolsIdx && toolsIdx < creatorIdx,
      `expected order SYSTEM(${systemIdx}) < TOOLS(${toolsIdx}) < CREATOR(${creatorIdx})`,
    );
  });

  it("substitutes {{agentId}} everywhere it appears and leaves no leftover placeholders", () => {
    const out = composeCreator("agt_abc1234567");
    assert.ok(out.includes("agt_abc1234567"), "{{agentId}} not substituted");
    assert.ok(!out.includes("{{agentId}}"), "{{agentId}} placeholder not fully replaced");
    assert.ok(
      !/\{\{[a-zA-Z_]+\}\}/.test(out),
      "composed creator-agent prompt still contains {{...}} placeholders",
    );
  });

  it("includes the runtime tool catalog so the creator can reference it when designing agents", () => {
    // Regression guard: the whole reason TOOLS.md was extracted was so
    // the creator's prompt actually contains the tool catalog. If
    // someone drops the TOOLS fragment from the creator composition,
    // this test should fire.
    const out = composeCreator("agt_abc1234567");
    assert.ok(out.includes("chat_send"), "creator prompt should reference chat_send (TOOLS.md)");
    assert.ok(
      out.includes("create_cron_job"),
      "creator prompt should reference create_cron_job (TOOLS.md)",
    );
    assert.ok(
      out.includes("list_integrations"),
      "creator prompt should reference list_integrations (TOOLS.md)",
    );
  });
});
