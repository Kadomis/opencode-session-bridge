# Contributing

Thanks for your interest in improving OpenCode Session Bridge.

## Development

Requirements:

- Bun 1.4.5 or later
- Node.js 22 or later
- OpenCode V2.4.1 for live integration tests

Commands:

```bash
bun install
bun run typecheck
bun test
bun run test:coverage
bun audit
```

## Pull requests

- Keep changes focused.
- Add tests before changing behavior.
- Preserve the existing permission model.
- Do not add credentials or local paths.
- Update `CHANGELOG.md` for user-visible changes.
- Keep coverage at or above 80%.

## Security

Do not open a public issue for a security vulnerability. Use the repository's private security advisory process.
