/**
 * Driver subprocess for the secret-propagation integ test. Boots the
 * real chat-server `startSecretsWatcher` against argv[2] and emits
 * plain-line markers on stdout the Python test reads:
 *
 *   READY                  — watcher is up
 *   ONCHANGE               — onChange callback fired (one per debounce)
 *
 * Exits when stdin closes so the Python harness can shut us down
 * cleanly without sending signals.
 */

import { startSecretsWatcher } from "../../docker/agent/chat-server/src/secrets-watcher.ts";
import { rootLogger } from "../../docker/agent/chat-server/src/logger.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: _watcher_driver.ts <watch-dir>");
  process.exit(2);
}

const handle = startSecretsWatcher({
  dir,
  onChange: () => {
    // Use stdout.write (not console.log) so we control buffering.
    process.stdout.write("ONCHANGE\n");
  },
  logger: rootLogger,
  debounceMs: 100,
});

// Give the watcher a microtask to attach before the parent races us.
setImmediate(() => process.stdout.write("READY\n"));

process.stdin.on("end", () => {
  handle.stop();
  process.exit(0);
});
process.stdin.resume();
