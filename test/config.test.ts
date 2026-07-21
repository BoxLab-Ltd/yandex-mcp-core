import { describe, expect, it } from 'bun:test'
import {
    type AuthDefaults,
    isCustomApp,
    loadYandexAuthConfig,
    oauthClientConfig,
} from '../src/auth/config.js'

const DEFAULTS: AuthDefaults = {
    scope: 'metrika:read',
    appName: 'yandex-metrica-mcp',
    embeddedClientId: 'embedded-id',
    staticTokenEnv: 'YANDEX_METRIKA_TOKEN',
}

const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv

describe('loadYandexAuthConfig', () => {
    it('applies the defaults for an empty environment', () => {
        const cfg = loadYandexAuthConfig(env({}), DEFAULTS)
        expect(cfg.scope).toBe('metrika:read')
        expect(cfg.appName).toBe('yandex-metrica-mcp')
        expect(cfg.embeddedClientId).toBe('embedded-id')
        expect(cfg.loopbackPort).toBe(53682)
        expect(cfg.oauthBaseUrl).toBe('https://oauth.yandex.com')
        expect(cfg.staticToken).toBeUndefined()
        expect(isCustomApp(cfg)).toBe(false)
    })

    it('reads the static token and its _FILE override from the named env vars', () => {
        const cfg = loadYandexAuthConfig(
            env({
                YANDEX_METRIKA_TOKEN: 'tok',
                YANDEX_METRIKA_TOKEN_FILE: '/tmp/token.json',
            }),
            DEFAULTS,
        )
        expect(cfg.staticToken).toBe('tok')
        expect(cfg.tokenFile).toBe('/tmp/token.json')
    })

    it('picks up a user-supplied app (custom client id + secret)', () => {
        const cfg = loadYandexAuthConfig(
            env({
                YANDEX_OAUTH_CLIENT_ID: 'cid',
                YANDEX_OAUTH_CLIENT_SECRET: 'sec',
            }),
            DEFAULTS,
        )
        expect(cfg.customClientId).toBe('cid')
        expect(cfg.customClientSecret).toBe('sec')
        expect(isCustomApp(cfg)).toBe(true)
        expect(oauthClientConfig(cfg)).toEqual({
            clientId: 'cid',
            clientSecret: 'sec',
            baseUrl: 'https://oauth.yandex.com',
        })
    })

    it('falls back to the embedded client id when no override is set', () => {
        const cfg = loadYandexAuthConfig(env({}), DEFAULTS)
        expect(oauthClientConfig(cfg)).toEqual({
            clientId: 'embedded-id',
            clientSecret: undefined,
            baseUrl: 'https://oauth.yandex.com',
        })
    })

    it('rejects a loopback port outside 1024-65535', () => {
        expect(() =>
            loadYandexAuthConfig(
                env({ YANDEX_OAUTH_LOOPBACK_PORT: '80' }),
                DEFAULTS,
            ),
        ).toThrow(/YANDEX_OAUTH_LOOPBACK_PORT/)
    })

    it('rejects a malformed YANDEX_OAUTH_BASE_URL (missing scheme) at load time', () => {
        expect(() =>
            loadYandexAuthConfig(
                env({ YANDEX_OAUTH_BASE_URL: 'oauth.yandex.com' }),
                DEFAULTS,
            ),
        ).toThrow(/YANDEX_OAUTH_BASE_URL/)
    })

    it('accepts a valid custom YANDEX_OAUTH_BASE_URL', () => {
        const cfg = loadYandexAuthConfig(
            env({ YANDEX_OAUTH_BASE_URL: 'https://oauth.example.test' }),
            DEFAULTS,
        )
        expect(cfg.oauthBaseUrl).toBe('https://oauth.example.test')
    })
})
