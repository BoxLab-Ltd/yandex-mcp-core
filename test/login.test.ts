import { describe, expect, it } from 'bun:test'
import type { YandexAuthConfig } from '../src/auth/config.js'
import { interactiveLogin } from '../src/auth/login.js'

/** A fetch that only answers the PKCE token exchange with a fixed token. */
const fakeTokenFetch = (async (url: string | URL) => {
    if (String(url).endsWith('/token')) {
        return new Response(
            JSON.stringify({
                access_token: 'tok',
                expires_in: 3600,
                scope: 'test:read',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
    }
    return new Response('not found', { status: 404 })
}) as unknown as typeof fetch

function cfg(port: number): YandexAuthConfig {
    return {
        scope: 'test:read',
        appName: 'test-app',
        embeddedClientId: 'client-abc',
        loopbackPort: port,
        oauthBaseUrl: 'https://oauth.example',
    }
}

describe('interactiveLogin', () => {
    it('completes the loopback flow when the browser returns the code', async () => {
        const tokens = await interactiveLogin(cfg(54620), {
            fetchImpl: fakeTokenFetch,
            // Simulate Yandex redirecting the browser back to the loopback URL.
            openUrl: authUrl => {
                const u = new URL(authUrl)
                const redirect = u.searchParams.get('redirect_uri')!
                const state = u.searchParams.get('state')!
                void fetch(`${redirect}?code=THECODE&state=${state}`).then(r =>
                    r.text(),
                )
            },
            promptForCode: () => {
                throw new Error('OOB prompt should not run on the loopback path')
            },
        })
        expect(tokens.accessToken).toBe('tok')
        expect(tokens.scope).toBe('test:read')
    })

    it('falls back to copy-paste when forced', async () => {
        const tokens = await interactiveLogin(cfg(1), {
            forceOob: true,
            fetchImpl: fakeTokenFetch,
            openUrl: () => {},
            promptForCode: async () => 'PASTED-CODE',
        })
        expect(tokens.accessToken).toBe('tok')
    })

    it('throws in copy-paste mode without a prompt handler', async () => {
        await expect(
            interactiveLogin(cfg(1), {
                forceOob: true,
                fetchImpl: fakeTokenFetch,
                openUrl: () => {},
            }),
        ).rejects.toThrow(/copy-paste handler/)
    })
})
