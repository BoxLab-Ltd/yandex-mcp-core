# Contributing

Thanks for your interest in improving `@boxlab/yandex-mcp-core`.

## Development

This project is [Bun](https://bun.sh)-first; the published artifact is
Node-compatible.

```bash
bun install
bun run typecheck
bun run lint
bun test
bun run build      # emit dist/ with tsc
```

## Pull requests

- Keep changes focused; one logical change per PR.
- Make sure `bun run typecheck`, `bun run lint`, `bun test`, and `bun run build`
  all pass.
- This package is consumed by multiple servers, so treat the public API (the
  `src/index.ts` exports) as stable: a breaking change needs a major version bump
  and a coordinated update of the consumers.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `chore:`, …).
