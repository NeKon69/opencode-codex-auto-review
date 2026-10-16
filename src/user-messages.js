// Only confirmed, structured user messages enter this store. Prompt-admission
// hooks are deliberately not used: admission can still fail after those hooks.
export const MAX_USER_MESSAGE_CHARS = 16_000;
export const USER_MESSAGES_PREFIX = "sessions/user_messages/";
const MAX_RESTORED_MESSAGES = 4_096;
const EXCERPT_MARKER = "\n[context excerpt; omitted text]\n";

export function boundUserText(text) {
  if (text.length <= MAX_USER_MESSAGE_CHARS) return text;
  const available = MAX_USER_MESSAGE_CHARS - EXCERPT_MARKER.length;
  const head = Math.ceil(available / 2);
  return text.slice(0, head) + EXCERPT_MARKER + text.slice(-Math.floor(available / 2));
}

function validID(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

function projectMessage(message) {
  if (message?.type !== "user" || !validID(message.id) || typeof message.text !== "string") return undefined;
  // Never retain attachment contents, filenames, or arbitrary metadata.
  // Agent/skill presence is retained only as a completeness flag.
  const text = boundUserText(message.text);
  return {
    id: message.id,
    type: "user",
    text,
    incomplete: message.text.length > MAX_USER_MESSAGE_CHARS || message.incomplete === true ||
      [message.agents, message.skills].some((value) => value !== undefined &&
        (!Array.isArray(value) || value.length > 0)),
  };
}

export function createUserMessageStore(storage) {
  if (!storage?.get || !storage?.set || !storage?.scan) return undefined;
  const prefixFor = (sessionID) => {
    if (!validID(sessionID)) throw new TypeError("invalid session ID for user-message storage");
    return `${USER_MESSAGES_PREFIX}${sessionID}/`;
  };

  const capture = async (sessionID, messages) => {
    if (!Array.isArray(messages)) return;
    const prefix = prefixFor(sessionID);
    // Separate keys avoid read-modify-write races between parallel reviews.
    for (const message of messages) {
      const value = projectMessage(message);
      if (!value) continue;
      const key = prefix + value.id;
      const previous = await storage.get(key);
      if (JSON.stringify(previous) !== JSON.stringify(value)) await storage.set(key, value);
    }
  };

  return {
    capture,
    async restore(sessionID, messages) {
      await capture(sessionID, messages);
      const prefix = prefixFor(sessionID);
      const saved = new Map();
      let after;
      let scanned = 0;
      let incomplete = !Array.isArray(messages);
      do {
        const page = await storage.scan({ prefix, after, limit: Math.min(100, MAX_RESTORED_MESSAGES - scanned) });
        scanned += page.entries.length;
        for (const entry of page.entries) {
          const value = projectMessage(entry.value);
          if (!value || entry.key !== prefix + value.id) {
            incomplete = true;
            continue;
          }
          saved.set(value.id, value);
        }
        if (page.next === after && page.next !== undefined) throw new Error("user-message storage cursor did not advance");
        after = page.next;
        if (scanned >= MAX_RESTORED_MESSAGES && after !== undefined) {
          incomplete = true;
          break;
        }
      } while (after !== undefined);

      // Current canonical messages win (including metadata used by validation).
      for (const message of messages ?? []) {
        if (message?.type === "user" && validID(message.id)) saved.set(message.id, message);
      }
      // Restore only history covered by an actual checkpoint. Do not resurrect
      // newer prompts that disappeared because of undo/revert, or fall back to
      // stale saved authorization when the live transcript is unavailable.
      const checkpoints = (messages ?? []).filter((message) => message?.type === "compaction");
      const checkpoint = checkpoints.at(-1);
      const currentIDs = new Set((messages ?? []).filter((message) => message?.type === "user").map((message) => message.id));
      const canRestore = checkpoint?.status === "completed" && validID(checkpoint.id);
      if (checkpoint && !canRestore) incomplete = true;
      const users = [...saved.values()]
        .filter((message) => currentIDs.has(message.id) || (canRestore && message.id < checkpoint.id))
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      const remaining = (messages ?? []).filter((message) => message?.type !== "user" || !validID(message.id));
      return { messages: [...users, ...remaining], incomplete };
    },
  };
}
