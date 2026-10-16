import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import plugin from "../src/index.js";
import { createUserMessageStore } from "../src/user-messages.js";
import { reviewPermission } from "../src/review.js";
import { flushReviewLogs } from "../src/diagnostics.js";

function fixture(records = new Map()) {
  return {
    records,
    get: async (key) => structuredClone(records.get(key)),
    set: async (key, value) => { records.set(key, structuredClone(value)); },
    scan: async ({ prefix, after, limit }) => {
      const keys = [...records.keys()].filter((key) => key.startsWith(prefix) && (!after || key > after)).sort();
      const selected = keys.slice(0, limit);
      return { entries: selected.map((key) => ({ key, value: structuredClone(records.get(key)) })),
        ...(keys.length > limit ? { next: selected.at(-1) } : {}) };
    },
  };
}

test("compaction hook saves admitted text, which a fresh plugin store supplies to a later review", async () => {
  const directory = await mkdtemp("/tmp/opencode/codex-storage-integration-");
  const previousLog = process.env.OPENCODE_CODEX_AUTO_REVIEW_LOG;
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.OPENCODE_CODEX_AUTO_REVIEW_LOG = join(directory, "diagnostics.ndjson");
  process.env.XDG_CONFIG_HOME = directory;
  const hooks = new Map();
  const storage = fixture();
  let disposed = 0;
  let messages = [{ type: "user", id: "msg_001", text: "Do not publish anything.", files: [{ data: "ATTACHMENT_CANARY" }] }];
  const ctx = {
    storage,
    session: {
      context: async () => messages,
      hook: async (name, callback) => {
        hooks.set(name, callback);
        return { dispose: async () => { disposed++; } };
      },
    },
    permission: { hook: async () => ({ dispose: async () => { disposed++; } }) },
    integration: { connection: { active: async () => undefined } },
  };
  try {
    const cleanup = await plugin.setup(ctx);
    assert.deepEqual([...hooks.keys()], ["compaction"]);
    await hooks.get("compaction")({ sessionID: "ses_a", messages: [{ role: "user", content: "LOWERED_ATTACHMENT_CANARY" }] });
    await cleanup();
    assert.equal(disposed, 2);

    // Reopen a serialized storage snapshot, with no shared in-memory store.
    const snapshot = join(directory, "storage.json");
    await writeFile(snapshot, JSON.stringify([...storage.records]), { mode: 0o600 });
    const fresh = fixture(new Map(JSON.parse(await readFile(snapshot, "utf8"))));
    messages = [{ type: "compaction", id: "msg_002", status: "completed", summary: "Work on tests", recent: "Continue" }];
    const connection = { type: "credential", id: "test", method: "oauth" };
    ctx.integration.connection = {
      active: async () => connection,
      resolve: async () => ({ type: "oauth", methodID: "chatgpt-browser", access: "synthetic", expires: Date.now() + 60_000 }),
    };
    let prompt;
    const event = { sessionID: "ses_a", action: "shell", resources: ["pwd"], effect: "ask", source: { type: "tool" } };
    await reviewPermission(ctx, event, {
      userMessages: createUserMessageStore(fresh),
      generateImpl: async (input) => {
        prompt = input.prompt;
        return { text: JSON.stringify({ risk_level: "low", user_authorization: "high", outcome: "allow", rationale: "Narrow read." }) };
      },
    });
    assert.equal(event.effect, "allow");
    assert.equal(prompt.includes("Do not publish anything."), true);
    assert.equal(prompt.includes("ATTACHMENT_CANARY"), false);
    assert.equal(prompt.includes("LOWERED_ATTACHMENT_CANARY"), false);

    storage.set = async () => { throw new Error("synthetic disk failure"); };
    messages = [{ type: "user", id: "msg_003", text: "New instruction" }];
    await assert.rejects(hooks.get("compaction")({ sessionID: "ses_a" }), /Could not persist user messages/);
  } finally {
    await flushReviewLogs();
    if (previousLog === undefined) delete process.env.OPENCODE_CODEX_AUTO_REVIEW_LOG;
    else process.env.OPENCODE_CODEX_AUTO_REVIEW_LOG = previousLog;
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    await rm(directory, { recursive: true, force: true });
  }
});

test("production plugin imports without node_modules or a host-version-specific schema", async () => {
  const directory = await mkdtemp("/tmp/opencode/codex-dependency-free-");
  try {
    await cp(new URL("../src", import.meta.url), join(directory, "src"), { recursive: true });
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    const loaded = await import(pathToFileURL(join(directory, "src/index.js")));
    assert.equal(loaded.default.id, "opencode-codex-auto-review");
    assert.equal(typeof loaded.default.setup, "function");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
