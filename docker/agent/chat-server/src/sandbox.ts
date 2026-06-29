/**
 * sandbox.ts — canUseTool callback for path confinement.
 *
 * Port of agent_turn.py's _build_can_use_tool / _realpath_under logic.
 * Resolves all filesystem paths via realpathSync() and denies anything
 * outside the session's cwd.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  PermissionResult,
  CanUseTool,
  HookCallback,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";
import { rootLogger } from "./logger.js";

/** Tool names whose arguments contain filesystem paths that need confinement. */
const FS_TOOL_PATH_FIELDS: Record<string, string[]> = {
  Read: ["file_path"],
  Edit: ["file_path"],
  Write: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"],
  Glob: ["path"],
  Grep: ["path"],
  LS: ["path"],
};

/** No tools are hard-blocked; Bash is confined via LD_PRELOAD libsandbox.so. */
const BLOCKED_TOOLS = new Set<string>();

/** User-facing reason returned when a `run_in_background` Bash call is
 * denied. Surfaced to the model as the tool's error so it self-corrects
 * toward spawn_background_task. */
export const BASH_BG_DENY_MESSAGE =
  "run_in_background is disabled: background shells die when this turn " +
  "ends, so the command would be killed before finishing. Either run it " +
  "in the foreground (single commands may take up to 10 minutes), or use " +
  "spawn_background_task for work that must outlive this turn — it runs " +
  "detached and reports back to this chat.";

/** True for a Bash tool call that asks the CLI to background the command.
 * Pure + exported for unit testing. */
export function isBackgroundBashCall(
  toolName: string,
  toolInput: unknown,
): boolean {
  return (
    toolName === "Bash" &&
    typeof toolInput === "object" &&
    toolInput !== null &&
    (toolInput as Record<string, unknown>).run_in_background === true
  );
}

/**
 * Build a PreToolUse hook that denies `run_in_background` Bash calls.
 *
 * Why a hook and not canUseTool: the real Claude CLI dispatches a
 * backgrounded Bash through its own background-shell subsystem, which
 * does NOT consult the canUseTool permission callback — empirically a
 * canUseTool deny of run_in_background is silently bypassed in the
 * deployed CLI (foreground tools and FS confinement still go through
 * canUseTool fine). PreToolUse fires earlier, before that dispatch, and
 * its deny is authoritative, so it actually blocks the background spawn.
 *
 * Harness background shells die when the turn ends, taking the work with
 * them; spawn_background_task is the cross-turn mechanism. The deny is
 * logged so operators can see how often models still reach for it.
 */
export function buildBashBackgroundPreToolUseHook(
  logger: Logger,
  ctx?: { cwd?: string },
): HookCallback {
  return async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return {};
    if (!isBackgroundBashCall(input.tool_name, input.tool_input)) return {};
    const command =
      typeof (input.tool_input as Record<string, unknown>)?.command === "string"
        ? String((input.tool_input as Record<string, unknown>).command).slice(0, 200)
        : "";
    logger.info(
      { event: "sandbox.bash_bg.denied", cwd: ctx?.cwd, command },
      "denied Bash run_in_background (PreToolUse)",
    );
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: BASH_BG_DENY_MESSAGE,
      },
    };
  };
}

/**
 * True iff `targetPath` (after realpath) is the root or a descendant of
 * ANY of the given roots.
 *
 * Node's `fs.realpathSync` throws ENOENT if any component along the path
 * is missing — unlike Python's `os.path.realpath`, which resolves the
 * longest existing prefix and leaves the rest literal. The original
 * sandbox (agent_turn.py) relied on the Python semantics, so Write
 * creating a new file Just Worked. To preserve that, we fall back to
 * resolving the deepest existing ancestor and re-appending the
 * non-existent tail. Safe because symlinks can only live at existing
 * directory entries — nothing under the first missing component can
 * redirect the path.
 *
 * Multiple roots support is for runtime-agent sessions that have a
 * read-only def/ scope plus a read+write workdir/ scope — the caller
 * passes both roots to the read check and just the workdir root to the
 * write check (see `buildCanUseTool`).
 */
function realpathUnder(targetPath: string, roots: string | readonly string[]): boolean {
  const rootList = typeof roots === "string" ? [roots] : roots;
  const absolute = resolve(targetPath);
  let resolved: string;
  try {
    resolved = realpathSync(absolute);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      rootLogger.info(
        { event: "sandbox.realpath_failed", path: targetPath, code, expected: true },
        "realpath failed (path rejected by confinement)",
      );
      return false;
    }
    const fallback = resolveExistingAncestor(absolute);
    if (!fallback) return false;
    resolved = fallback;
  }
  return rootList.some((root) => {
    const rel = relative(root, resolved);
    return !rel.startsWith("..") && !isAbsolute(rel);
  });
}

/**
 * Walk up `absolute` until a component exists, realpath that ancestor,
 * then re-attach the non-existent tail. Returns `""` if even the
 * filesystem root isn't resolvable (should never happen).
 */
function resolveExistingAncestor(absolute: string): string {
  const tail: string[] = [];
  let ancestor = absolute;
  while (true) {
    const parent = dirname(ancestor);
    tail.unshift(basename(ancestor));
    try {
      const resolvedParent = realpathSync(parent);
      return join(resolvedParent, ...tail);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") return "";
    }
    if (parent === ancestor) return "";
    ancestor = parent;
  }
}

/**
 * Confinement scope: which filesystem trees the session can touch.
 *
 *   cwd        — read+write allowed (the agent's working directory).
 *   extraRead  — read-only roots (each a path prefix). Write/Edit tools
 *                whose target resolves here are denied even though Read
 *                would succeed. Used for runtime agents that see a
 *                read-only def/ tree alongside their writable workdir/.
 */
export interface SandboxScope {
  cwd: string;
  extraRead?: readonly string[];
}

/** Tools that WRITE to their `file_path`/`path` argument. Confined to the
 * scope's cwd only. Read-only tools are confined to cwd ∪ extraRead. */
const FS_WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Build a canUseTool callback scoped to the given session cwd plus
 * optional read-only extra roots.
 */
export function buildCanUseTool(scope: SandboxScope | string): CanUseTool {
  const { cwd: rawCwd, extraRead: rawExtra = [] }: SandboxScope =
    typeof scope === "string" ? { cwd: scope } : scope;
  // Realpath the roots once at construction so host-level symlinks
  // (e.g. /var → /private/var on macOS; /tmp ↔ /private/tmp) don't cause
  // path comparisons to fail. Targets are already realpath'd in
  // realpathUnder; realpath'ing the roots too makes the comparison
  // symmetric. Missing roots keep their literal form — realpathUnder's
  // ENOENT fallback handles non-existent target paths.
  const normalize = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const cwd = normalize(rawCwd);
  const readRoots: readonly string[] = rawExtra.length
    ? [cwd, ...rawExtra.map(normalize)]
    : [cwd];

  return async function canUseTool(
    toolName: string,
    toolInput: Record<string, unknown>,
    _options: { signal: AbortSignal; toolUseID: string },
  ): Promise<PermissionResult> {
    // Hard deny list (defense-in-depth).
    if (BLOCKED_TOOLS.has(toolName)) {
      return {
        behavior: "deny",
        message: `Tool ${toolName} is disabled in this sandbox.`,
      };
    }

    // NOTE: `run_in_background` Bash is denied via a PreToolUse hook
    // (buildBashBackgroundPreToolUseHook), NOT here. The real CLI
    // dispatches a backgrounded Bash through its own background-shell
    // subsystem, which bypasses this canUseTool callback — a deny at this
    // layer is silently ignored (confirmed live: foreground tools + FS
    // confinement go through canUseTool fine, backgrounded Bash does not).
    // The hook fires earlier, before that dispatch, so it actually blocks.

    const fields = FS_TOOL_PATH_FIELDS[toolName];
    if (fields) {
      // Writes go to cwd only; reads may target any extraRead root too.
      const roots = FS_WRITE_TOOLS.has(toolName) ? [cwd] : readRoots;
      for (const field of fields) {
        const value = toolInput[field];
        if (typeof value !== "string" || !value) continue;

        const candidate = isAbsolute(value) ? value : resolve(cwd, value);
        if (!realpathUnder(candidate, roots)) {
          return {
            behavior: "deny",
            message:
              `Path '${value}' resolves outside the session workdir ` +
              `(${cwd}). Filesystem tools are confined to the session cwd.`,
          };
        }
      }
    }

    return { behavior: "allow", updatedInput: toolInput };
  };
}

/**
 * Per-turn registry of `options.agentID` → agents-map key.
 *
 * The SDK assigns each Task-spawned subagent its own short
 * per-invocation handle (e.g. `aff25fc`) and threads THAT, not the
 * agents-map key (e.g. `agt_6e895145fc`), through the canUseTool
 * `options.agentID`. Empirically confirmed: Task on
 * `subagent_type=agt_6e895145fc` surfaces `agentID=aff25fc` in the
 * permission callback.
 *
 * The `SubagentStart` hook fires once per subagent invocation with
 * BOTH ids in the same payload (`agent_id` = the per-invocation
 * handle, `agent_type` = the agents-map key). The hook records the
 * mapping into this registry; canUseTool reads it back to scope the
 * tool call. One registry per supervisor turn, lives only as long
 * as the `query()` call.
 */
export interface SubagentRegistry {
  /** Hook handler — call this from the SubagentStart hook. */
  record(agentInvocationId: string, agentTypeKey: string): void;
  /** canUseTool helper — translate per-invocation id to agents-map key. */
  lookup(agentInvocationId: string): string | undefined;
}

export function createSubagentRegistry(): SubagentRegistry {
  const map = new Map<string, string>();
  return {
    record(agentInvocationId, agentTypeKey) {
      map.set(agentInvocationId, agentTypeKey);
    },
    lookup(agentInvocationId) {
      return map.get(agentInvocationId);
    },
  };
}

/**
 * canUseTool for a supervisor that owns SDK-native subagents. The
 * supervisor itself is confined to `supervisorScope`; when a tool call
 * arrives from a subagent (SDK populates `options.agentID` in that
 * case), we swap to the subagent's scope — resolved via the caller's
 * `resolveAgentScope`.
 *
 * Identity resolution: `options.agentID` is the SDK's per-invocation
 * handle. Look it up in `subagentRegistry` (populated by the
 * SubagentStart hook) to get the agents-map key, then resolve the
 * scope. If the lookup fails — race between SubagentStart firing
 * and the first tool call — fall through to allow rather than block
 * the agent on a timing artefact. Workspace-wide isolation still
 * holds (gVisor + LD_PRELOAD bash sandbox + EFS access-point chroot
 * + the supervisor's own scope on the supervisor's tool calls).
 *
 * Per-subagent scopes are cached by invocation id so a long subagent
 * turn doesn't re-resolve on every tool call.
 */
export function buildSupervisorCanUseTool(
  supervisorScope: SandboxScope,
  resolveAgentScope: (agentTypeKey: string) => SandboxScope | null,
  subagentRegistry: SubagentRegistry,
): CanUseTool {
  const supervisorCheck = buildCanUseTool(supervisorScope);
  const cache = new Map<string, CanUseTool>();
  return async (toolName, toolInput, options) => {
    // The SDK threads the subagent's identity through the permission
    // callback via `options.agentID` when the call originates inside
    // a Task-spawned subagent. Absent = supervisor's own call.
    const agentInvocationId =
      (options as { agentID?: string }).agentID ?? undefined;
    if (!agentInvocationId) {
      return supervisorCheck(toolName, toolInput, options);
    }
    let subagentCheck = cache.get(agentInvocationId);
    if (!subagentCheck) {
      const agentTypeKey = subagentRegistry.lookup(agentInvocationId);
      const scope = agentTypeKey ? resolveAgentScope(agentTypeKey) : null;
      if (!scope) {
        rootLogger.info(
          {
            event: "sandbox.subagent.unmapped_id",
            agentID: agentInvocationId,
            agentTypeKey,
            toolName,
            expected: !agentTypeKey, // race with SubagentStart hook is normal
          },
          "subagent identity unmapped; allowing tool call",
        );
        return { behavior: "allow", updatedInput: toolInput };
      }
      subagentCheck = buildCanUseTool(scope);
      cache.set(agentInvocationId, subagentCheck);
    }
    // Note: we attempted to rewrite Bash commands here for subagents
    // (prepend `cd <agent-workdir> && ...`) so the agent's pwd would
    // reflect its own workdir. Empirically, the SDK does NOT invoke
    // canUseTool for subagent tool calls (or at minimum doesn't honor
    // updatedInput on that path), so the rewrite never reached the
    // running command. The agent's prompt now instructs it to ALWAYS
    // use absolute paths in Bash to avoid the cwd-mismatch trap.
    return subagentCheck(toolName, toolInput, options);
  };
}
