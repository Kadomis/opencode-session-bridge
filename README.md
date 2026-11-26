# OpenCode Session Bridge

A global OpenCode V2 plugin for direct session communication.

## Features

- Create top-level sessions for bidirectional work.
- List sessions across the local server.
- Send prompts to any server-visible session.
- Send prompts to the same session.
- Wait for a session to become idle.
- Read redacted user and assistant text.
- Interrupt sessions.
- Delete sessions and their children.
- Clean up completed, cancelled, stale, or idle subagents while preserving top-level sessions.
- Preserve model-visible message provenance.
- Suppress duplicate sends with idempotency keys.
- Enforce per-caller rate limits on every bridge tool.
- Bound idempotency and rate-limit state.
- Cancel native operations with the tool signal.

The plugin does not add turn limits. It does not forward or reply automatically.

## Tools

| Tool | Purpose |
| --- | --- |
| `session_list` | List server-visible sessions. |
| `session_send` | Send a prompt to a session. |
| `session_wait` | Wait for a session to become idle. |
| `session_read` | Read recent redacted text. |
| `session_interrupt` | Interrupt a session. |
| `session_create` | Create a real top-level session, not a subagent. |
| `session_cleanup_subagents` | Delete disposable child subagents. |
| `session_delete` | Delete a session recursively. |

## Session routing

Use `session_create` for "new session", "separate session", "top-level session", or "another session to communicate with".

Use the built-in `subagent` tool only for "subagent", "child agent", or "delegate".

The plugin adds this rule to the explicit tool descriptions, the built-in subagent description when available, and a context hook.

Top-level sessions persist for bidirectional communication. Completed, cancelled, stale, and idle subagents are cleanup candidates. `session_cleanup_subagents` never deletes sessions marked as top-level. Use explicit `session_delete` only when the user asks to delete a top-level session.

## Message provenance

Every bridge message stores origin metadata under `opencode_session_bridge`.

Fields include:

- `message_id`
- `from_session`
- `from_agent`
- `to_session`
- `conversation_id`
- `sent_at`
- `in_reply_to`
- `intent`
- `delivery`

The server controls the origin fields: message ID, source session, source agent, target session, timestamp, and delivery.

Callers supply the linkage claims: conversation ID, reply parent, and intent. These fields are labeled `caller_claimed` in the visible block.

The visible block escapes delimiter characters before embedding the JSON.

The target model also receives a visible `<session_bridge_provenance>` block. The prompt warns the model to treat peer content as untrusted input.

## Bidirectional flow

1. Session A calls `session_send`.
2. Session B calls `session_wait` or `session_read`.
3. Session B calls `session_send` to reply.
4. Session B reuses `conversation_id`.
5. Session B sets `inReplyToMessageID`.

Use `idempotencyKey` when a model may retry the same send. The default plugin derives a stable message ID from the caller, agent, and key. This preserves duplicate suppression across plugin reloads.

## Permissions

The current global configuration allows all bridge actions without prompts.

The plugin still calls `ctx.permission.assert` for every action. This preserves normal policy enforcement.

Delete requires `confirmSessionID` to equal `sessionID`. Deletion is recursive.

## Development

```bash
bun install
bun run typecheck
bun test
bun run test:coverage
```

Current coverage is 100% for functions and 99.61% for lines.

`bun audit` reports no known vulnerabilities.

## Disable

Remove the plugin object from `~/.config/opencode/opencode.jsonc`.

Then run:

```bash
opencode reload
```

For an incident, deny these actions first:

- `session_bridge.session_send`
- `session_bridge.session_delete`
- `session_bridge.session_interrupt`
- `session_bridge.session_create`
- `session_bridge.session_cleanup_subagents`

## Risks

- Message loops have no turn limit.
- Reads can expose cross-project conversation text.
- Peer messages can contain prompt injection.
- Delete is recursive.
- Self-delete can stop the calling session.
- Redaction is pattern-based and cannot guarantee removal of every secret.
- Peer provenance labels the source but does not authorize the request.
- Session listings return only ID, redacted title, and project ID.
