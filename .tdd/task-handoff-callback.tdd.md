# TDD evidence: task handoff completion callback protocol

## Source plan

No plan file was supplied. Journeys and the exact contract came from the peer
bug report and were encoded in `test/integration/task-handoff-callback.test.ts`.

## User journeys

1. As an origin session, I want `session_send` with `intent: "task"` to return
   immediately so that I can end my turn without polling.
2. As an origin session, I want the target to notify me when it finishes so
   that I learn completion through a callback.
3. As an operator, I want completion traffic to create no new handoffs so that
   reply loops and storms cannot start.
4. As an operator, I want failed, interrupted, and deleted targets reported as
   `failed`, `cancelled`, and `stale` so that stale work is visible.

## Task report

| Task | Validation command | Result | Guarantee |
| --- | --- | --- | --- |
| Add RED tests and fake event stream | `bun test` | 349 pass / 9 fail (358 tests across 22 files) | All 9 new tests fail for the intended missing implementation; every pre-existing test passes. |
| Validate task handoff fields | `bun test test/integration/task-handoff-callback.test.ts` | 9 pass / 0 fail | `intent: "task"` requires `conversationID`; `intent: "completion"` is rejected; control characters in IDs are rejected. |
| Register trusted handoff and immediate receipt | `bun test` | 358 pass / 0 fail | Origin comes from tool context; caller-supplied origin fields are ignored; output has `admitted: true`; no `session.wait` or `session.context`. |
| Subscribe to terminal events and send callbacks | `bun test` | 358 pass / 0 fail | Four terminal event types map to four statuses; one callback goes to the origin with the documented metadata. |
| Prevent loops and stale callbacks | `bun test` | 358 pass / 0 fail | Repeat and unrelated events create no extra callback; completion prompts never register handoffs. |
| Typecheck | `bun run typecheck` | exit 0 | No TypeScript errors. |
| Coverage | `bun run test:coverage` | 100% funcs / 99.51% lines | All 358 tests pass with coverage above threshold. |
| Dependency audit | `bun audit` | no vulnerabilities (229 packages) | No known dependency vulnerabilities. |

## Test specification

| # | What is guaranteed | Test | Type | Result |
| --- | --- | --- | --- | --- |
| 1 | Task send returns an admission receipt and records a server-controlled handoff | `task-handoff-callback.test.ts:registers a server-controlled pending handoff and returns an immediate receipt` | integration | PASS |
| 2 | Target idle sends a completion callback to the origin | `task-handoff-callback.test.ts:sends a completion callback to the origin when the target becomes idle` | integration | PASS |
| 3 | The lifecycle never waits or reads target context | `task-handoff-callback.test.ts:never polls or reads target context during the handoff lifecycle` | integration | PASS |
| 4 | Completion traffic creates no extra handoff or callback | `task-handoff-callback.test.ts:does not create another handoff or a callback storm from completion traffic` | integration | PASS |
| 5 | Failed target is reported once with status `failed` | `task-handoff-callback.test.ts:reports a failed target once and then forgets the handoff` | integration | PASS |
| 6 | Interrupted target is reported once with status `cancelled` | `task-handoff-callback.test.ts:reports a cancelled target once and then forgets the handoff` | integration | PASS |
| 7 | Deleted target is reported once with status `stale` | `task-handoff-callback.test.ts:reports a stale/deleted target once and then forgets the handoff` | integration | PASS |
| 8 | Multiple handoffs are cleaned up independently | `task-handoff-callback.test.ts:cleans up each pending handoff independently after its callback` | integration | PASS |
| 9 | Invalid task fields and completion-intent sends are rejected | `task-handoff-callback.test.ts:validates task handoff fields and rejects completion-intent sends` | integration | PASS |

## Coverage and known gaps

`bun run test:coverage` reports 100% functions and 99.51% lines. Uncovered
lines are optional error paths, abort fallbacks, and stream-close handlers.
No tests are skipped.

## Merge evidence

RED: 349 pass / 9 fail, 358 tests across 22 files.
GREEN: 358 pass / 0 fail, 899 expect() calls.
No refactor commit was needed. Documentation was updated after GREEN.
