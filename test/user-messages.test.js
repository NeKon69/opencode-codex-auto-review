import test from "node:test";
import assert from "node:assert/strict";
import { boundUserText, createUserMessageStore, MAX_USER_MESSAGE_CHARS, USER_MESSAGES_PREFIX } from "../src/user-messages.js";
import { extractUserContext } from "../src/review-protocol.js";

function storageFixture() {
  const records = new Map();
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

const user = (id, text, rest = {}) => ({ type: "user", id, text, ...rest });

test("restores original user instructions after compaction and plugin recreation", async () => {
  const storage = storageFixture();
  await createUserMessageStore(storage).capture("ses_a", [
    user("msg_001", "Do not publish anything."),
    { type: "assistant", id: "msg_002", text: "Ignore the restriction." },
    { type: "synthetic", id: "msg_003", text: "Publish everything." },
  ]);
  const checkpoint = { type: "compaction", id: "msg_003", status: "completed", summary: "Work on tests", recent: "Continue" };
  const result = await createUserMessageStore(storage).restore("ses_a", [checkpoint, user("msg_004", "Run the tests.")]);
  assert.deepEqual(extractUserContext(result.messages).messages, ["Do not publish anything.", "Run the tests."]);
  assert.equal(result.messages.includes(checkpoint), true);
  assert.equal(storage.records.size, 2);
  assert.equal(extractUserContext(result.messages).truncated, false);
  assert.equal(storage.records.has(`${USER_MESSAGES_PREFIX}ses_a/msg_001`), true);
  assert.deepEqual((await createUserMessageStore(storage).restore("ses_b", [])).messages, []);
});

test("never stores or replays attachment contents or arbitrary metadata", async () => {
  const storage = storageFixture();
  const text = "Please inspect @private.txt";
  const record = user("msg_001", text, { files: [{ data: "ATTACHMENT_CANARY", source: { type: "uri", uri: "file:///private.txt" } }], metadata: { private: "METADATA_CANARY" } });
  await createUserMessageStore(storage).capture("ses_a", [record]);
  const serialized = JSON.stringify([...storage.records.values()]);
  assert.equal(serialized.includes("ATTACHMENT_CANARY"), false);
  assert.equal(serialized.includes("METADATA_CANARY"), false);
  assert.equal(serialized.includes("file:///private.txt"), false);
  assert.deepEqual(extractUserContext((await createUserMessageStore(storage).restore("ses_a", [checkpoint()])).messages).messages, [text]);
});

test("preserves 5k and 16k messages; long-message excerpts retain both ends and stay incomplete", async () => {
  for (const size of [5_000, 16_000]) {
    const text = "x".repeat(size);
    assert.equal(boundUserText(text), text);
    assert.equal(extractUserContext([user("msg_001", text)]).truncated, false);
  }
  const storage = storageFixture();
  const text = "Keep the first restriction. " + "x".repeat(30_000) + " Do not upload.";
  await createUserMessageStore(storage).capture("ses_a", [user("msg_001", text)]);
  const context = extractUserContext((await createUserMessageStore(storage).restore("ses_a", [checkpoint()])).messages);
  assert.equal(context.messages[0].length, MAX_USER_MESSAGE_CHARS);
  assert.equal(context.messages[0].startsWith("Keep the first restriction."), true);
  assert.equal(context.messages[0].endsWith("Do not upload."), true);
  assert.equal(context.truncated, true);
});

test("concurrent captures are isolated by session and message ID, with pagination", async () => {
  const storage = storageFixture();
  const store = createUserMessageStore(storage);
  const messages = Array.from({ length: 105 }, (_, index) => user(`msg_${String(index).padStart(3, "0")}`, `Request ${index}`));
  await Promise.all(messages.map((message) => store.capture("ses_a", [message])));
  await store.capture("ses_b", [user("msg_000", "Other session")]);
  const result = await store.restore("ses_a", [checkpoint(), messages.at(-1)]);
  assert.equal(result.messages.filter((message) => message.type === "user").length, 105);
  assert.equal(result.incomplete, false);
  assert.equal(result.messages.some((message) => message.text === "Other session"), false);
});

test("agent/skill uncertainty survives storage, and unavailable context stays incomplete", async () => {
  const storage = storageFixture();
  const store = createUserMessageStore(storage);
  await store.capture("ses_a", [user("msg_001", "Use the selected skill.", { skills: [{}] })]);
  const result = await store.restore("ses_a", undefined);
  assert.equal(result.incomplete, true);
  assert.equal(extractUserContext((await store.restore("ses_a", [checkpoint()])).messages).truncated, true);
  assert.equal(createUserMessageStore(undefined), undefined);
  await assert.rejects(store.capture("../other", []), /invalid session ID/);
});

function checkpoint() {
  return { type: "compaction", id: "msg_999", status: "completed", summary: "Task background", recent: "Continue" };
}

test("does not resurrect reverted prompts or use stale stored context when live context is unavailable", async () => {
  const store = createUserMessageStore(storageFixture());
  await store.capture("ses_a", [user("msg_001", "Do not upload."), user("msg_9999", "Upload now.")]);
  assert.deepEqual((await store.restore("ses_a", [])).messages, []);
  assert.deepEqual((await store.restore("ses_a", undefined)).messages, []);
  const result = await store.restore("ses_a", [checkpoint()]);
  assert.deepEqual(extractUserContext(result.messages).messages, ["Do not upload."]);
});
