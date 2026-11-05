import { describe, expect, it } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { YandexAuthConfig } from '../src/auth/config.js'
import { startLoopback } from '../src/auth/loopback.js'
import { SessionTokenProvider } from '../src/auth/provider.js'
import { registerLoginTools } from '../src/mcp/loginTools.js'

const PORT = 54631

describe('login tool', () => {
    it('frees the loopback port as soon as the call is cancelled', async () => {
        const config: YandexAuthConfig = {
            scope: 'test:read',
            appName: 'test-app',
            embeddedClientId: 'client',
            loopbackPort: PORT,
            oauthBaseUrl: 'https://oauth.example',
        }
        const server = new McpServer({ name: 's', version: '0' })
        let opened = ''
        registerLoginTools(server, {
            config,
            provider: new SessionTokenProvider(null),
            store: { path: ':memory:', read: () => null, write: () => {} },
            openUrl: url => {
                opened = url
            },
        })
        const client = new Client({ name: 'c', version: '0' })
        const [a, b] = InMemoryTransport.createLinkedPair()
        await Promise.all([server.connect(a), client.connect(b)])

        const ac = new AbortController()
        const call = client
            .callTool({ name: 'login', arguments: {} }, undefined, {
                signal: ac.signal,
            })
            .catch(() => null)
        while (!opened) await new Promise(r => setTimeout(r, 10))
        ac.abort()
        await call
        await new Promise(r => setTimeout(r, 50))

        const again = await startLoopback({
            port: PORT,
            state: 'x',
            timeoutMs: 1000,
        })
        again.close()
        void again.code.catch(() => {})
        await client.close()
        expect(opened).toContain('scope=test%3Aread')
    })
})
