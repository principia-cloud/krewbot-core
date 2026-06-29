/**
 * Tests for the secrets watcher that drives Chat SDK adapter reloads.
 *
 * This used to be a 30s setInterval, which gave a ~45s worst-case
 * propagation for a rotated bot token (15s sidecar tick + 30s here).
 * The watcher version targets single-digit seconds — the load-bearing
 * behaviors are:
 *
 *   - A file change in the watched dir fires onChange (the whole
 *     reason this exists; if this regresses we silently go back to
 *     "rotation doesn't take effect").
 *   - Bursts within the debounce window collapse to one onChange.
 *     The sidecar's sync.py rewrites secret files one-by-one via
 *     write_if_changed → atomic rename, so a sync pass that touches N
 *     adapter secrets fires N watcher events. Without coalescing, the
 *     Chat SDK rebuild logic gets called N times per refresh.
 *   - If the watched dir doesn't exist yet at startup (sidecar still
 *     creating it), the watcher retries instead of crashing the boot.
 */

import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startSecretsWatcher } from "../src/secrets-watcher.ts";
import { rootLogger } from "../src/logger.ts";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "secrets-watcher-test-"));

after(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

/** Wait until `predicate()` is true, or fail after `timeoutMs`. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("startSecretsWatcher", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(TMP_ROOT, `case-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
  });

  it("fires onChange when a file in the watched dir changes", async () => {
    let calls = 0;
    const handle = startSecretsWatcher({
      dir: testDir,
      onChange: () => {
        calls += 1;
      },
      logger: rootLogger,
      debounceMs: 50,
    });
    try {
      writeFileSync(join(testDir, "telegram-bot-token"), "rotated-value-1");
      await waitFor(() => calls >= 1);
      assert.equal(calls, 1, "expected exactly one onChange after first write");
    } finally {
      handle.stop();
    }
  });

  it("coalesces a burst of writes into a single onChange", async () => {
    // The sidecar's sync_workspace_secrets rewrites each changed secret
    // file individually via atomic rename. If the watcher fired onChange
    // per event, a single sync pass touching the 8 adapter secrets would
    // call maybeReloadChatSdk 8 times in a row — wasteful and racy.
    let calls = 0;
    const handle = startSecretsWatcher({
      dir: testDir,
      onChange: () => {
        calls += 1;
      },
      logger: rootLogger,
      debounceMs: 100,
    });
    try {
      for (const name of [
        "telegram-bot-token",
        "slack-bot-token",
        "slack-signing-secret",
        "whatsapp-access-token",
        "whatsapp-app-secret",
        "whatsapp-phone-number-id",
        "teams-app-id",
        "teams-app-password",
      ]) {
        writeFileSync(join(testDir, name), "x");
      }
      // Give the debounce a chance to settle.
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(
        calls,
        1,
        `8 burst writes should debounce to 1 onChange; got ${calls}`,
      );
    } finally {
      handle.stop();
    }
  });

  it("recovers when the watched directory doesn't exist at start", async () => {
    // Sidecar creates /config/secrets on first tick; chat-server boots
    // in parallel and may race that. The watcher must keep retrying
    // instead of taking down the server.
    const lateDir = join(TMP_ROOT, `late-${Date.now()}`);
    let calls = 0;
    const handle = startSecretsWatcher({
      dir: lateDir,
      onChange: () => {
        calls += 1;
      },
      logger: rootLogger,
      debounceMs: 50,
      restartDelayMs: 50,
    });
    try {
      // Create the dir well after the watcher started — it should have
      // retried by then and be ready for events.
      await new Promise((r) => setTimeout(r, 150));
      mkdirSync(lateDir, { recursive: true });
      // Give it a moment for the retry to pick up the now-existing dir.
      await new Promise((r) => setTimeout(r, 200));
      writeFileSync(join(lateDir, "telegram-bot-token"), "late-token");
      await waitFor(() => calls >= 1, 3_000);
    } finally {
      handle.stop();
      rmSync(lateDir, { recursive: true, force: true });
    }
  });

  it("fires onChange via polling even with no filesystem event", async () => {
    // The load-bearing case on the real platform: /config is EFS and the
    // sidecar writing it is a separate NFS client, so inotify (fs.watch)
    // never delivers the change to this process. The poll must drive
    // onChange on its own, with zero fs events. No writes happen here.
    let calls = 0;
    const handle = startSecretsWatcher({
      dir: testDir,
      onChange: () => {
        calls += 1;
      },
      logger: rootLogger,
      debounceMs: 10,
      pollMs: 40,
    });
    try {
      await waitFor(() => calls >= 2, 2_000);
      assert.ok(calls >= 2, `expected poll-driven onChange; got ${calls}`);
    } finally {
      handle.stop();
    }
  });
});
