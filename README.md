# @boxlab/yandex-mcp-core

Shared plumbing for **Yandex MCP servers** — so authentication, the HTTP
client and the common MCP helpers live in one place across the family
(`yandex-metrica-mcp`, `yandex-webmaster-mcp`, …).

It provides:

- **Auth** — Yandex ID OAuth (authorization-code + PKCE, no client secret),
  sign-in over a **loopback redirect** (the browser returns the code
  automatically) with a copy-paste fallback, token providers that boot even
  before the first sign-in, and a CLI helper.
- **`login` / `submit_code` MCP tools** — sign in from the client, no terminal.
- **`YandexClient`** — a small HTTP client (retries, concurrency cap, timeouts,
  streaming) that talks to any Yandex REST API.
- **`YandexApiError`** + `errorResult` / `toToolResult` — error mapping and MCP
  result shaping.

Each server plugs in its own OAuth scope, app id, token-cache name and static
token env var; nothing is shared at runtime between servers except the code.

## Usage

```ts
import {
    loadYandexAuthConfig,
    resolveTokenProvider,
    registerLoginTools,
    runAuthCli,
    YandexClient,
} from '@boxlab/yandex-mcp-core'

const auth = loadYandexAuthConfig(process.env, {
    scope: 'metrika:read',
    appName: 'yandex-metrica-mcp',
    embeddedClientId: '<your public client id>',
    staticTokenEnv: 'YANDEX_METRIKA_TOKEN',
})

// CLI: `my-server auth`
if (process.argv[2] === 'auth') await runAuthCli(auth)

const { provider, store } = resolveTokenProvider(auth)
const client = new YandexClient({
    baseUrl: 'https://api-metrika.yandex.net',
    userAgent: 'yandex-metrica-mcp/0.2.0',
    getToken: () => provider.getAccessToken(),
    onUnauthorized: rejected => provider.forceRefresh(rejected),
    canRefresh: () => provider.canRefresh(),
    maxConcurrency: 3,
    requestTimeoutMs: 60_000,
})

// register the login/submit_code tools; they own token persistence
registerLoginTools(server, { config: auth, provider, store })
```

## License

MIT
