# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub's
[**Private Vulnerability Reporting**](https://github.com/BoxLab-Ltd/yandex-mcp-core/security/advisories/new)
(Security → Report a vulnerability). Do not open a public issue for security
problems. We aim to respond within a few business days.

## Security model

This package is the shared auth and HTTP layer for Yandex MCP servers:

- **No secrets in the package.** Sign-in uses authorization-code + PKCE with a
  **public** OAuth client (client_id only, no secret); it ships no tokens or
  keys.
- **Tokens stay local.** Access/refresh tokens are cached by the consuming
  server at `~/.config/<app>/token.json` with `0600` permissions, and are never
  logged or written to stdout.
- **Talks only to Yandex.** The sign-in flow reaches `oauth.yandex.com`; the
  HTTP client targets whichever Yandex API base the consuming server configures.
  No third-party endpoints.
