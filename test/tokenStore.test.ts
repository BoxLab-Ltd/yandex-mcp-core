import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    createFileTokenStore,
    defaultTokenPath,
} from '../src/auth/tokenStore.js'

describe('tokenStore', () => {
    it('roundtrips a token set and writes it with 0600 perms', () => {
        const dir = mkdtempSync(join(tmpdir(), 'ymcore-'))
        // Nest one level deeper so write() actually creates the leaf dir.
        const leaf = join(dir, 'some-app')
        const path = join(leaf, 'token.json')
        const store = createFileTokenStore(path)
        try {
            expect(store.read()).toBeNull()
            const ts = {
                accessToken: 'AT',
                refreshToken: 'RT',
                expiresAt: 123456,
                scope: 'test:read',
            }
            store.write(ts)
            expect(store.read()).toEqual(ts)
            expect(statSync(path).mode & 0o777).toBe(0o600)
            expect(statSync(leaf).mode & 0o777).toBe(0o700)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('builds the path under XDG_CONFIG_HOME / appName', () => {
        expect(
            defaultTokenPath('some-app', {
                XDG_CONFIG_HOME: '/cfg',
            } as NodeJS.ProcessEnv),
        ).toBe('/cfg/some-app/token.json')
    })

    it('defaults under ~/.config/appName when no XDG', () => {
        const p = defaultTokenPath('some-app', {} as NodeJS.ProcessEnv)
        expect(p.endsWith('/.config/some-app/token.json')).toBe(true)
    })
})
