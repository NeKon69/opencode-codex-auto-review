# OpenCode Codex Auto Review

A plugin for OpenCode V2 that reviews eligible pending tool-permission asks using Codex Auto Review. Direct user text is saved in durable plugin storage so it can be restored after compaction; a completed checkpoint's `summary` and `recent` fields remain supplementary, lossy background.

The reviewer receives no tools and cannot execute the requested action. The plugin validates its JSON assessment, applies a configurable approval profile, and returns a permission decision to OpenCode.

## Features

- **Persistent user context:** saves admitted user text before compaction and during reviews, separately from model summaries. Summary-only context remains restricted to low-risk approvals.
- **Approval profiles:** five profiles define which risk and authorization combinations can be allowed.
- **Unresolved-ask fallback:** independently leaves unresolved asks pending or denies them for unattended workflows, subject to reviewer-availability exceptions.
- **Bounded review:** limits context, resources, and prompt size. Diagnostics exclude credentials, prompts, resources, custom-policy text, and model rationale.
- **Custom reviewer policies:** combines always-applicable user rules with project-scoped rules, while preserving built-in review limits and approval profiles.

## How a review works

1. OpenCode raises a pending (`ask`) permission request from a tool, with a concrete action and bounded resource list.
2. The plugin loads eligible direct user text and, when present, the latest compaction checkpoint that OpenCode marks completed.
3. Codex Auto Review returns a strict JSON assessment: risk, user authorization, outcome, and a short rationale.
4. The plugin validates the response and applies the selected approval profile in code. Any remaining `ask` is handled by the separate fallback setting.

The plugin reviews only tool-originated asks. Other permission sources are left alone. A valid model-backed `deny` is honored for critical risk or for medium/high risk with unknown authorization; other unresolved results use the configured fallback.

## Context, including after compaction

The plugin uses OpenCode’s structured session message types; it does not search ordinary conversation text for something that merely looks like a summary. A compaction checkpoint is accepted only when it is the latest checkpoint in the supplied context, has `type: "compaction"` and `status: "completed"`, contains a non-empty `summary`, and has a string `recent` field.

- User messages up to 16,000 characters (including 5k messages) are kept intact. Longer messages retain a head-and-tail excerpt marked incomplete. Up to 256 direct user text messages are supplied within a combined 200,000-character context budget. Exceeding the count or budget makes the context incomplete rather than silently dropping older user intent.
- The latest completed checkpoint contributes its `summary` and `recent` fields. If it is the only available context, the reviewer cannot infer high authorization, and the code permits only low-risk approvals in every profile.
- Assistant and tool messages are not treated as direct user authorization. A compaction summary is lossy background, not a verbatim user instruction.
- File attachments and `files` metadata are ignored; neither attachment content nor file metadata is sent to the reviewer. Non-empty `agents` or `skills` metadata makes the context incomplete. Missing, running, failed, or empty checkpoints are not used; oversized context is sent as a bounded excerpt marked incomplete.
- Permission actions are limited to 128 characters; resources are limited to 128 entries, 16,000 characters per entry, and 256 KiB total UTF-8. The complete generated review prompt is capped at 1 MiB.

The reviewer is still called when context is incomplete. It receives the bounded available text (if any) and an explicit `context_complete: false` marker, so it can assess the permission request without mistaking omitted history for authorization. Its assessment still goes through the configured approval profile and unresolved-request fallback.

### Durable user-message map

Records use OpenCode's durable, plugin-scoped `ctx.storage`, at
`sessions/user_messages/<sessionID>/<messageID>`. One key per message avoids
parallel-review read/modify/write races. Records survive compaction, plugin
reloads, and server restarts; they are not project files or diagnostics.
Only structured, admitted `type: "user"` text is stored, with its message ID and
an incompleteness flag. Attachment contents, arbitrary metadata, assistant/tool
output, and summaries are never saved as direct user authorization. This is
local persistent prompt data: text pasted into a user message is still text.

Reviews capture visible direct messages, and the compaction hook saves them
before they leave active context. A failed pre-compaction write blocks that
compaction rather than silently losing the record. Already-compacted messages
from before installation cannot be reconstructed. The store retains bounded
text for every observed message; reviews scan at most 4,096 saved messages and
mark larger histories incomplete before applying the stricter prompt budgets.
Stored text is only replayed for a completed checkpoint, not as a substitute
for unavailable live history or for reverted post-checkpoint prompts.
Records are retained until removed from plugin storage; session deletion does
not currently purge this additional map.

File references/attachments are separate structured fields. OpenCode can expand
them into the main agent's model context, but this reviewer ignores those
fields entirely (including file data); a literal `@path` in user text stays as
text. Ordinary pasted text has no reliable typed/pasted provenance field in the
server user-message schema, so it is not guessed or stripped. Long pasted text
is subject to the same 16k excerpt limit. None of these changes rewrites the
main agent's input or changes its attachment behavior.

## Approval profiles

Set `OPENCODE_CODEX_AUTO_REVIEW_MODE` in the OpenCode server’s environment, or set the plugin’s `options.mode` in `opencode.json`. The config option takes precedence over the environment variable. The default is `balanced`; an unknown value resolves to `manual`.

| Profile | What the plugin can automatically allow |
|---|---|
| `manual` | Nothing. A qualifying model-backed denial can still be applied. |
| `strict` | Low risk, and only with high authorization. |
| `cautious` | Low risk with medium-or-higher authorization; medium risk only with high authorization. |
| `balanced` *(default)* | Low or medium risk with medium-or-higher authorization; high risk only with high authorization. |
| `permissive` | Low, medium, or high risk with medium-or-higher authorization. Critical risk is never allowed. |

The model supplies the risk and authorization labels; the plugin enforces the profile thresholds. In summary-only reviews, the additional low-risk-only cap applies even when `permissive` is selected.

## Unresolved-ask fallback

Set `OPENCODE_CODEX_AUTO_REVIEW_FALLBACK` in the OpenCode server’s environment, or set the plugin’s `options.fallback` in `opencode.json`. The config option takes precedence over the environment variable. This setting is independent of the approval profile:

| Value | Behavior |
|---|---|
| `ask` *(default)* | Leave unresolved tool asks pending for a person. |
| `deny` | Deny unresolved tool asks, including threshold misses and plugin-side failures. Reviewer unavailability remains `ask`; incomplete context is reviewed by the model first. |

Non-tool permission asks are unchanged. Incomplete context is sent to the reviewer with a completeness marker, and the model's resulting assessment is applied normally. Reviewer unavailability (a missing/ineligible ChatGPT connection, a changed connection, a failed or timed-out generation call, or an unusable assessment) stays `ask` even when the fallback is `deny`.

For example, this allows balanced approvals, denies other unresolved tool asks, and still asks a person if the reviewer cannot give a usable answer:

```sh
export OPENCODE_CODEX_AUTO_REVIEW_MODE=balanced
export OPENCODE_CODEX_AUTO_REVIEW_FALLBACK=deny
opencode
```

## Custom review policies

Add reviewer instructions in either or both of these Markdown files:

- **Always / user-wide:** `$XDG_CONFIG_HOME/opencode/codex-auto-review.md`; when `XDG_CONFIG_HOME` is unset or relative, `~/.config/opencode/codex-auto-review.md` is used.
- **Project-level:** `<project-root>/.opencode/codex-auto-review.md`. Only the current project root is checked; parent directories and `AGENTS.md` are not loaded as review policy.

Both files are read for each review and sent to the reviewer. The global policy takes precedence over project policy; project rules cannot weaken global or built-in constraints. Policy text does not count as evidence that the current user authorized an action, and ambiguity or conflict should result in `ask`.

Each file is limited to 4,000 characters (8,000 combined). Files must be regular files inside their owning roots; symlinks are rejected. Missing files are ignored. An unreadable, oversized, or out-of-scope policy makes the review unresolved and follows the configured fallback without calling the model.

These are model-facing instructions, not a deterministic permission ACL. Project rules are repository content and should be reviewed before trusting them. Policy contents are sent to OpenAI with the review request; do not put secrets in them. Use OpenCode sandbox and permission rules for boundaries that must be enforced independently of the model.

## Install and configure

The plugin has no runtime OpenCode-schema or Effect dependency. It uses the
host plugin context and plain model definitions rather than importing a
version-specific schema into the host's shared Effect runtime. Schema packages
are unpinned development-only fixtures. This avoids dependency-version coupling,
but cannot guarantee compatibility with future breaking changes to OpenCode's
plugin API or the internal reviewer model.

Install the package dependencies, then add the local plugin directory to OpenCode’s `opencode.json`:

```sh
cd /absolute/path/to/opencode-codex-auto-review
npm install
```

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-codex-auto-review",
      "options": {
        "mode": "permissive",
        "fallback": "deny"
      }
    }
  ]
}
```

Log in to OpenCode with a supported ChatGPT OAuth connection before starting or reloading the server. The plugin registers the reviewer only when it finds OpenCode’s existing native ChatGPT/Codex provider route; it does not create or rewrite shared provider settings. Either configure `mode` and `fallback` as plugin options or set their environment variables before launching the server.

## Diagnostics and development

Sanitized JSONL diagnostics are written to `~/.local/share/opencode/log/codex-auto-review.ndjson`, or `$XDG_DATA_HOME/opencode/log/codex-auto-review.ndjson`. Records include decision categories, timings, context sizes, context-validation failure categories, policy presence/lengths, and byte counts, but exclude resource values, session IDs, policy text, prompt text, credentials, provider error messages, and model rationale. Override the path with `OPENCODE_CODEX_AUTO_REVIEW_LOG`.

```sh
npm install
npm test
npm run check
npm pack
```

The tests cover provider-route-aware model registration, permission filtering, compaction context and budget limits, custom-policy loading and scope, profile and fallback decisions, OAuth eligibility, connection changes, bounded concurrency, timeout/cancellation handling, diagnostics redaction, and malformed assessments. The assessment shape is based on public Codex sources; no Codex implementation code is copied.

## Sources and license

- [Codex Auto Review model catalogue](https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json)
- [Codex Guardian assessment schema](https://github.com/openai/codex/blob/main/codex-rs/ext/guardian-reviewer/src/assessment.rs)
- [OpenCode v2.0.24 compaction implementation](https://github.com/anomalyco/opencode/blob/v2.0.24/packages/core/src/session/compaction.ts)
- [OpenCode v2.0.24 compaction-message projection](https://github.com/anomalyco/opencode/blob/v2.0.24/packages/core/src/session/message-updater.ts)
- [OpenCode v2.0.24 session history](https://github.com/anomalyco/opencode/blob/v2.0.24/packages/core/src/session/history.ts)
- [OpenCode session-context API](https://opencode.ai/v2/docs/api/session/v2-session-context)
- [OpenCode V2 plugin API](https://github.com/anomalyco/opencode/tree/v2.0.24/packages/plugin)

MIT License — Copyright (c) 2026 NeKon69. See [LICENSE](LICENSE). This project is not affiliated with or endorsed by OpenAI or the OpenCode maintainers.

## Caveats

- `codex-auto-review` is a hidden/internal model, not a stable public review API. OpenAI or OpenCode may change or remove it, and its usage or billing treatment is not guaranteed.
- Only OpenCode’s `chatgpt-browser` and `chatgpt-headless` OAuth methods are accepted. API-key auth and paid-model fallbacks are intentionally unsupported; without an eligible connection or the expected native route, the plugin cannot obtain a reviewer verdict.
- `FALLBACK=deny` is not a guarantee of prompt-free unattended operation: reviewer/API unavailability and unusable responses stay `ask` so a person can take over.
- Compaction summaries are lossy and their provenance is handled through reviewer instructions, not a formal policy engine. The code enforces the summary-only approval cap, but risk and authorization classification still depends on the model’s assessment.
- OpenCode’s generation API does not pin a specific connection. The plugin rechecks the active connection immediately before generation, but cannot eliminate a connection switch in the final check/use window.
- Five reviews can run concurrently, and the 30-second review timeout includes time spent waiting in the queue. OpenCode's plugin API and internal reviewer availability can change independently of this plugin.
