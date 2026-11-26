# Changelog

## 1.1.0 - 2026-11-26

- Add `session_create` for true top-level sessions.
- Add `session_cleanup_subagents` for completed, cancelled, stale, and idle subagents.
- Add explicit routing guidance to tool descriptions, context, and the built-in subagent description.
- Preserve top-level sessions during subagent cleanup.
- Add integration tests for creation, bidirectional messaging, routing, and cleanup.

## 1.0.0 - 2026-11-26

- Initial public release.
- Add session listing, messaging, waiting, reading, interruption, and recursive deletion.
- Add model-visible provenance with trusted and caller-claimed fields.
- Add permission checks, rate limits, redaction, cancellation, and bounded state.
- Add deterministic message IDs for keyed sends.
- Add comprehensive unit and integration tests.
- Ship a compiled JavaScript entry point with no runtime dependencies.
- Pin CI actions and restrict workflow permissions.
