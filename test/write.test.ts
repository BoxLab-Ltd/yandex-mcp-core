import { describe, expect, it } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
    ElicitRequestSchema,
    ErrorCode,
    McpError,
} from '@modelcontextprotocol/sdk/types.js'
import {
    loadYandexAuthConfig,
    requestedScope,
    type YandexAuthConfig,
} from '../src/auth/config.js'
import { withScope } from '../src/auth/login.js'
import {
    SessionTokenProvider,
    StaticTokenProvider,
} from '../src/auth/provider.js'
import { assertWriteAccess, WriteAccessError } from '../src/auth/writeAccess.js'
import {
    createMutationConfirmer,
    type Confirmation,
} from '../src/mcp/confirm.js'

const tokenOf = (c: Confirmation) =>
    c.confirmed
        ? undefined
        : (c.result.structuredContent?.confirm_token as string | undefined)

const DEFAULTS = {
    scope: 'metrika:read',
    writeScope: 'metrika:write',
    writeEnv: 'YANDEX_METRIKA_ENABLE_WRITE',
    appName: 'app',
    embeddedClientId: 'id',
    staticTokenEnv: 'YANDEX_METRIKA_TOKEN',
}

const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv

describe('write flag and requested scope', () => {
    it('asks only for the base scope while writes are off', () => {
        const cfg = loadYandexAuthConfig(env({}), DEFAULTS)
        expect(cfg.writeEnabled).toBe(false)
        expect(requestedScope(cfg)).toBe('metrika:read')
    })

    it('adds the write scope when the flag is on', () => {
        const cfg = loadYandexAuthConfig(
            env({ YANDEX_METRIKA_ENABLE_WRITE: 'true' }),
            DEFAULTS,
        )
        expect(cfg.writeEnabled).toBe(true)
        expect(requestedScope(cfg)).toBe('metrika:read metrika:write')
    })

    it('rejects a flag value it cannot read instead of guessing', () => {
        expect(() =>
            loadYandexAuthConfig(
                env({ YANDEX_METRIKA_ENABLE_WRITE: 'maybe' }),
                DEFAULTS,
            ),
        ).toThrow(/YANDEX_METRIKA_ENABLE_WRITE/)
    })

    it('records the requested scope when the token response has none', () => {
        expect(withScope({ accessToken: 't', expiresAt: 0 }, 'a b').scope).toBe(
            'a b',
        )
        expect(
            withScope({ accessToken: 't', expiresAt: 0, scope: 'x' }, 'a b')
                .scope,
        ).toBe('x')
    })
})

describe('assertWriteAccess', () => {
    const on: YandexAuthConfig = {
        ...loadYandexAuthConfig(
            env({ YANDEX_METRIKA_ENABLE_WRITE: '1' }),
            DEFAULTS,
        ),
    }

    it('refuses when writes are disabled, naming the flag', async () => {
        const off = loadYandexAuthConfig(env({}), DEFAULTS)
        const p = new SessionTokenProvider({ accessToken: 't', expiresAt: 0 })
        await expect(assertWriteAccess(off, p)).rejects.toThrow(
            /YANDEX_METRIKA_ENABLE_WRITE=1/,
        )
    })

    it('asks for a fresh sign-in when the token is read-only', async () => {
        const p = new SessionTokenProvider({
            accessToken: 't',
            expiresAt: 0,
            scope: 'metrika:read',
        })
        const err = await assertWriteAccess(on, p).catch(e => e)
        expect(err).toBeInstanceOf(WriteAccessError)
        expect(String(err.message)).toMatch(/login/)
    })

    it('treats a cached token without a recorded scope as read-only', async () => {
        const p = new SessionTokenProvider({ accessToken: 't', expiresAt: 0 })
        await expect(assertWriteAccess(on, p)).rejects.toBeInstanceOf(
            WriteAccessError,
        )
    })

    it('passes a read-write token and a static token', async () => {
        const rw = new SessionTokenProvider({
            accessToken: 't',
            expiresAt: 0,
            scope: 'metrika:read metrika:write',
        })
        await assertWriteAccess(on, rw)
        await assertWriteAccess(on, new StaticTokenProvider('s'))
    })

    it('gates on the flag alone when the server has no separate write scope', async () => {
        const base = loadYandexAuthConfig(env({ W: '1' }), {
            ...DEFAULTS,
            writeScope: undefined,
            writeEnv: 'W',
        })
        await assertWriteAccess(
            base,
            new SessionTokenProvider({ accessToken: 't', expiresAt: 0 }),
        )
        const off = loadYandexAuthConfig(env({}), {
            ...DEFAULTS,
            writeScope: undefined,
            writeEnv: 'W',
        })
        await expect(
            assertWriteAccess(
                off,
                new SessionTokenProvider({ accessToken: 't', expiresAt: 0 }),
            ),
        ).rejects.toThrow(/W=1/)
    })

    it('reports a missing sign-in before the scope', async () => {
        await expect(
            assertWriteAccess(on, new SessionTokenProvider(null)),
        ).rejects.toThrow(/not signed in/i)
    })
})

const PREVIEW = {
    tool: 'create_annotation',
    summary: 'Create annotation "Release" on 2026-11-01',
    request: { counterId: 1, chart_annotation: { title: 'Release' } },
}

async function connect(
    elicit?: (message: string) => Promise<{ action: string }>,
): Promise<McpServer> {
    const server = new McpServer({ name: 's', version: '0' })
    const client = new Client(
        { name: 'c', version: '0' },
        { capabilities: elicit ? { elicitation: {} } : {} },
    )
    if (elicit) {
        client.setRequestHandler(ElicitRequestSchema, async req => {
            const r = await elicit(req.params.message)
            return r as { action: 'accept' | 'decline' | 'cancel' }
        })
    }
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    return server
}

describe('mutation confirmer — token flow', () => {
    it('returns a preview first, then confirms the same request once', async () => {
        const confirmer = createMutationConfirmer(await connect())
        const first = await confirmer.confirm(PREVIEW)
        expect(first.confirmed).toBe(false)
        const token = tokenOf(first)!
        expect(token).toBeTruthy()
        expect((await confirmer.confirm(PREVIEW, token)).confirmed).toBe(true)
        expect((await confirmer.confirm(PREVIEW, token)).confirmed).toBe(false)
    })

    it('does not accept a token for different arguments', async () => {
        const confirmer = createMutationConfirmer(await connect())
        const first = await confirmer.confirm(PREVIEW)
        const token = tokenOf(first)!
        const changed = {
            ...PREVIEW,
            request: { counterId: 2, chart_annotation: { title: 'Release' } },
        }
        expect((await confirmer.confirm(changed, token)).confirmed).toBe(false)
    })

    it('does not accept an expired token', async () => {
        let t = 0
        const confirmer = createMutationConfirmer(await connect(), {
            ttlMs: 1000,
            now: () => t,
        })
        const first = await confirmer.confirm(PREVIEW)
        const token = tokenOf(first)!
        t = 5000
        expect((await confirmer.confirm(PREVIEW, token)).confirmed).toBe(false)
    })

    it('binds to content, not key order', async () => {
        const confirmer = createMutationConfirmer(await connect())
        const first = await confirmer.confirm({
            ...PREVIEW,
            request: { a: 1, b: { c: 2, d: 3 } },
        })
        const token = tokenOf(first)!
        const again = await confirmer.confirm(
            { ...PREVIEW, request: { b: { d: 3, c: 2 }, a: 1 } },
            token,
        )
        expect(again.confirmed).toBe(true)
    })
})

describe('mutation confirmer — elicitation', () => {
    it('applies when the user accepts the prompt', async () => {
        let shown = ''
        const confirmer = createMutationConfirmer(
            await connect(async m => {
                shown = m
                return { action: 'accept' }
            }),
        )
        expect((await confirmer.confirm(PREVIEW)).confirmed).toBe(true)
        expect(shown).toContain('Create annotation "Release"')
    })

    it('does not apply when the user declines, and issues no token', async () => {
        const confirmer = createMutationConfirmer(
            await connect(async () => ({ action: 'decline' })),
        )
        const r = await confirmer.confirm(PREVIEW)
        expect(r.confirmed).toBe(false)
        expect(
            (r as { result: { structuredContent: Record<string, unknown> } })
                .result.structuredContent.confirm_token,
        ).toBeUndefined()
    })

    it('treats a failed prompt as not approved', async () => {
        const confirmer = createMutationConfirmer(
            await connect(async () => {
                throw new Error('boom')
            }),
        )
        const r = await confirmer.confirm(PREVIEW)
        expect(r.confirmed).toBe(false)
    })

    it('falls back to the token flow when the client cannot elicit after all', async () => {
        const confirmer = createMutationConfirmer(
            await connect(async () => {
                throw new McpError(ErrorCode.MethodNotFound, 'nope')
            }),
        )
        const r = await confirmer.confirm(PREVIEW)
        expect(
            (r as { result: { structuredContent: Record<string, unknown> } })
                .result.structuredContent.confirm_token,
        ).toBeTruthy()
    })
})
