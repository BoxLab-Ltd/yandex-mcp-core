import type { OAuthClientConfig } from './oauth.js'

export const DEFAULT_LOOPBACK_PORT = 53682
export const DEFAULT_OAUTH_BASE_URL = 'https://oauth.yandex.com'

/** Per-server auth configuration passed into the shared auth code. */
export interface YandexAuthConfig {
    /** OAuth scope this server requests, e.g. 'metrika:read'. */
    scope: string
    /** App identity: token-cache dir segment + User-Agent, e.g. 'yandex-metrica-mcp'. */
    appName: string
    /** Built-in public client id for this server's Yandex app. */
    embeddedClientId: string
    /** Fixed loopback redirect port (must match the app's registered URI). */
    loopbackPort: number
    /** Yandex ID OAuth base URL. */
    oauthBaseUrl: string
    /** Override client id (a user's own app) — enables refresh with the secret. */
    customClientId?: string
    customClientSecret?: string
    /** Static token from the environment (alternative to the `login` flow). */
    staticToken?: string
    /** Explicit token-cache path override. */
    tokenFile?: string
}

/** True when the config points at the user's own OAuth app (id override present). */
export function isCustomApp(config: YandexAuthConfig): boolean {
    return config.customClientId !== undefined
}

/** Build the OAuth client config: the custom app id if set, else the embedded one. */
export function oauthClientConfig(config: YandexAuthConfig): OAuthClientConfig {
    return {
        clientId: config.customClientId ?? config.embeddedClientId,
        clientSecret: config.customClientSecret,
        baseUrl: config.oauthBaseUrl,
    }
}

/**
 * Drop empty and unexpanded-`${...}` values so an optional, unset variable reads
 * as absent. A Desktop Extension (.mcpb) substitutes an untouched optional
 * user_config into the env as `""`, which would otherwise fail a server's
 * validation and stop it from starting.
 */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) continue
        const trimmed = value.trim()
        if (trimmed === '' || /^\$\{[^}]*\}$/.test(trimmed)) continue
        out[key] = value
    }
    return out
}

export interface AuthDefaults {
    scope: string
    appName: string
    embeddedClientId: string
    /** Env var name carrying a static token, e.g. 'YANDEX_METRIKA_TOKEN'. */
    staticTokenEnv: string
    loopbackPort?: number
    oauthBaseUrl?: string
}

/**
 * Parse the standard Yandex OAuth env vars into a {@link YandexAuthConfig}:
 * `YANDEX_OAUTH_CLIENT_ID`/`_SECRET`, `YANDEX_OAUTH_BASE_URL`,
 * `YANDEX_OAUTH_LOOPBACK_PORT`, the server's static-token var and its `_FILE`
 * override. Empty/placeholder values are treated as unset (see cleanEnv).
 */
export function loadYandexAuthConfig(
    env: NodeJS.ProcessEnv,
    defaults: AuthDefaults,
): YandexAuthConfig {
    const e = cleanEnv(env)
    const portRaw = e.YANDEX_OAUTH_LOOPBACK_PORT
    const loopbackPort = portRaw
        ? Number(portRaw)
        : (defaults.loopbackPort ?? DEFAULT_LOOPBACK_PORT)
    if (
        !Number.isInteger(loopbackPort) ||
        loopbackPort < 1024 ||
        loopbackPort > 65535
    ) {
        throw new Error(
            `YANDEX_OAUTH_LOOPBACK_PORT must be an integer 1024-65535 (got "${portRaw}")`,
        )
    }
    return {
        scope: defaults.scope,
        appName: defaults.appName,
        embeddedClientId: defaults.embeddedClientId,
        loopbackPort,
        oauthBaseUrl:
            e.YANDEX_OAUTH_BASE_URL ??
            defaults.oauthBaseUrl ??
            DEFAULT_OAUTH_BASE_URL,
        customClientId: e.YANDEX_OAUTH_CLIENT_ID,
        customClientSecret: e.YANDEX_OAUTH_CLIENT_SECRET,
        staticToken: e[defaults.staticTokenEnv],
        tokenFile: e[`${defaults.staticTokenEnv}_FILE`],
    }
}
