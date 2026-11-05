import { afterEach, describe, expect, it } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
    parseTransportOptions,
    serveHttp,
    type HttpServerHandle,
} from '../src/mcp/http.js'

let handles: HttpServerHandle[] = []
afterEach(async () => {
    for (const h of handles) await h.close()
    handles = []
})

let sessionsCreated = 0
function createSession(): McpServer {
    sessionsCreated += 1
    const server = new McpServer({ name: 'test', version: '0' })
    server.registerTool(
        'echo',
        { inputSchema: { text: z.string() } },
        async ({ text }) => ({ content: [{ type: 'text', text }] }),
    )
    return server
}

async function start(opts: { host?: string; token?: string } = {}) {
    const h = await serveHttp(createSession, {
        host: opts.host ?? '127.0.0.1',
        port: 0,
        token: opts.token,
    })
    handles.push(h)
    return h
}

async function connect(url: string, headers: Record<string, string> = {}) {
    const client = new Client({ name: 'c', version: '0' })
    await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
            requestInit: { headers },
        }),
    )
    return client
}

const INIT = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw', version: '0' },
    },
}

describe('serveHttp', () => {
    it('serves tools over Streamable HTTP, one server per session', async () => {
        const h = await start()
        const before = sessionsCreated
        const a = await connect(h.url)
        const b = await connect(h.url)
        const { tools } = await a.listTools()
        expect(tools.map(t => t.name)).toEqual(['echo'])
        const r = await b.callTool({ name: 'echo', arguments: { text: 'hi' } })
        expect((r.content as Array<{ text: string }>)[0]!.text).toBe('hi')
        expect(sessionsCreated - before).toBe(2)
        await a.close()
        await b.close()
    })

    it('rejects a foreign Host header (DNS rebinding)', async () => {
        const h = await start()
        const res = await fetch(h.url, {
            method: 'POST',
            headers: {
                Host: 'evil.example',
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify(INIT),
        })
        expect(res.status).toBe(403)
    })

    it('rejects a cross-site Origin', async () => {
        const h = await start()
        const res = await fetch(h.url, {
            method: 'POST',
            headers: {
                Origin: 'https://evil.example',
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify(INIT),
        })
        expect(res.status).toBe(403)
    })

    it('requires the bearer token when one is set', async () => {
        const h = await start({ token: 's3cret' })
        const res = await fetch(h.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify(INIT),
        })
        expect(res.status).toBe(401)
        const ok = await connect(h.url, { Authorization: 'Bearer s3cret' })
        expect((await ok.listTools()).tools).toHaveLength(1)
        await ok.close()
    })

    it('answers 404 for an unknown session and for other paths', async () => {
        const h = await start()
        const stale = await fetch(h.url, {
            method: 'POST',
            headers: {
                'mcp-session-id': 'nope',
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/list',
            }),
        })
        expect(stale.status).toBe(404)
        const other = await fetch(h.url.replace('/mcp', '/other'))
        expect(other.status).toBe(404)
    })

    it('refuses a non-loopback bind without a token', async () => {
        await expect(
            serveHttp(createSession, { host: '0.0.0.0', port: 0 }),
        ).rejects.toThrow(/token/)
    })
})

describe('parseTransportOptions', () => {
    const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv

    it('stays on stdio unless HTTP is asked for', () => {
        expect(parseTransportOptions([], env({}), { port: 7801 })).toEqual({
            mode: 'stdio',
        })
    })

    it('reads flags, then env, with loopback and the default port', () => {
        expect(
            parseTransportOptions(['--http'], env({}), { port: 7801 }),
        ).toEqual({
            mode: 'http',
            host: '127.0.0.1',
            port: 7801,
            token: undefined,
        })
        expect(
            parseTransportOptions(
                ['--http', '--port', '9000'],
                env({ MCP_HTTP_PORT: '1' }),
                { port: 7801 },
            ),
        ).toMatchObject({ port: 9000 })
        expect(
            parseTransportOptions(
                [],
                env({ MCP_TRANSPORT: 'http', MCP_HTTP_PORT: '9100' }),
                {
                    port: 7801,
                },
            ),
        ).toMatchObject({ mode: 'http', port: 9100 })
    })

    it('refuses a public bind without MCP_HTTP_TOKEN', () => {
        expect(() =>
            parseTransportOptions(['--http', '--host', '0.0.0.0'], env({}), {
                port: 7801,
            }),
        ).toThrow(/MCP_HTTP_TOKEN/)
        expect(
            parseTransportOptions(
                ['--http', '--host=0.0.0.0'],
                env({ MCP_HTTP_TOKEN: 't' }),
                { port: 7801 },
            ),
        ).toMatchObject({ host: '0.0.0.0', token: 't' })
    })
})
