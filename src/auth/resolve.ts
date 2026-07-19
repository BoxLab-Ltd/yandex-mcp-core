import { isCustomApp, oauthClientConfig, type YandexAuthConfig } from './config.js'
import {
    RefreshingTokenProvider,
    SessionTokenProvider,
    StaticTokenProvider,
    type TokenProvider,
} from './provider.js'
import {
    createFileTokenStore,
    defaultTokenPath,
    type TokenStore,
} from './tokenStore.js'

export interface ResolvedAuth {
    provider: TokenProvider
    /** The token cache, so `login` can persist a freshly obtained token set. */
    store: TokenStore
    /** Human-readable description of the chosen source, for a startup log. */
    mode: string
}

/**
 * Choose a token source, in priority order:
 *   1. A cached token file (from `auth`/`login`). Refresh runs only with a
 *      user's own app (client secret present); the embedded public client has
 *      no secret, so its ~1-year token is used as-is (re-login on expiry).
 *   2. A static token from the environment.
 *   3. Otherwise boot unauthenticated — tool calls fail with actionable
 *      guidance until the user signs in, rather than refusing to start.
 */
export function resolveTokenProvider(
    config: YandexAuthConfig,
    env: NodeJS.ProcessEnv = process.env,
): ResolvedAuth {
    const path = config.tokenFile ?? defaultTokenPath(config.appName, env)
    const store = createFileTokenStore(path)
    const cached = store.read()

    if (cached) {
        if (isCustomApp(config) && config.customClientSecret) {
            return {
                provider: new RefreshingTokenProvider(
                    store,
                    oauthClientConfig(config),
                    undefined,
                    cached,
                ),
                store,
                mode: `token file with refresh (${store.path})`,
            }
        }
        return {
            provider: new SessionTokenProvider(cached.accessToken, store),
            store,
            mode: `token file (${store.path}); ~1-year token, re-run \`auth\` when it expires`,
        }
    }

    if (config.staticToken) {
        return {
            provider: new StaticTokenProvider(config.staticToken),
            store,
            mode: 'static token from the environment',
        }
    }

    return {
        provider: new SessionTokenProvider(null, store),
        store,
        mode: 'not signed in — use the `login` tool or the `auth` command',
    }
}
