import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { YandexAuthConfig } from '../src/auth/config.js'
import { resolveTokenProvider } from '../src/auth/resolve.js'
import { createFileTokenStore } from '../src/auth/tokenStore.js'

function baseConfig(overrides: Partial<YandexAuthConfig> = {}): YandexAuthConfig {
    return {
        scope: 'test:read',
        appName: 'test-app',
        embeddedClientId: 'cid',
        loopbackPort: 53682,
        oauthBaseUrl: 'https://oauth.example',
        ...overrides,
    }
}

function withTokenFile(overrides: Partial<YandexAuthConfig> = {}): {
    config: YandexAuthConfig
    file: string
    cleanup: () => void
} {
    const dir = mkdtempSync(join(tmpdir(), 'ymcore-resolve-'))
    const file = join(dir, 'token.json')
    return {
        config: baseConfig({ tokenFile: file, ...overrides }),
        file,
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
    }
}

describe('resolveTokenProvider', () => {
    it('boots unauthenticated with an actionable error when no credentials exist', async () => {
        const { config, cleanup } = withTokenFile()
        try {
            const { provider, mode } = resolveTokenProvider(config)
            expect(mode).toMatch(/not signed in/i)
            expect(provider.canRefresh()).toBe(false)
            await expect(provider.getAccessToken()).rejects.toThrow(
                /not signed in/i,
            )
        } finally {
            cleanup()
        }
    })

    it('uses a static token from config when no cached file exists', async () => {
        const { config, cleanup } = withTokenFile({ staticToken: 'static-tok' })
        try {
            const { provider, mode } = resolveTokenProvider(config)
            expect(mode).toMatch(/static/)
            expect(await provider.getAccessToken()).toBe('static-tok')
        } finally {
            cleanup()
        }
    })

    it('prefers a cached token file over a static token', async () => {
        const { config, file, cleanup } = withTokenFile({
            staticToken: 'static-tok',
        })
        try {
            createFileTokenStore(file).write({
                accessToken: 'cached-tok',
                refreshToken: 'RT',
                expiresAt: 9_999_999_999_999,
            })
            const { provider, mode } = resolveTokenProvider(config)
            expect(mode).toMatch(/token file/)
            expect(provider.canRefresh()).toBe(false)
            expect(await provider.getAccessToken()).toBe('cached-tok')
        } finally {
            cleanup()
        }
    })

    it('uses a refreshing provider with a custom app secret + cached file', () => {
        const { config, file, cleanup } = withTokenFile({
            customClientId: 'cid',
            customClientSecret: 'sec',
        })
        try {
            createFileTokenStore(file).write({
                accessToken: 'cached-tok',
                refreshToken: 'RT',
                expiresAt: 9_999_999_999_999,
            })
            const { mode } = resolveTokenProvider(config)
            expect(mode).toMatch(/token file with refresh/)
        } finally {
            cleanup()
        }
    })
})
