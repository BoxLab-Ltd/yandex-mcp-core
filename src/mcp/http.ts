import { randomUUID, timingSafeEqual } from 'node:crypto'
import {
    createServer as createHttpServer,
    type IncomingMessage,
    type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]']
const MAX_BODY_BYTES = 8 * 1024 * 1024
const DEFAULT_IDLE_MS = 30 * 60_000

export type TransportOptions =
    | { mode: 'stdio' }
    | { mode: 'http'; host: string; port: number; token?: string }

function flagValue(argv: string[], name: string): string | undefined {
    const i = argv.indexOf(name)
    if (i >= 0) return argv[i + 1]
    const eq = argv.find(a => a.startsWith(`${name}=`))
    return eq?.slice(name.length + 1)
}

export function isLoopbackHost(host: string): boolean {
    return LOOPBACK_HOSTS.includes(host.toLowerCase())
}

// The token comes only from the environment: a CLI flag would show up in `ps`.
export function parseTransportOptions(
    argv: string[],
    env: NodeJS.ProcessEnv,
    defaults: { port: number },
): TransportOptions {
    const http =
        argv.includes('--http') ||
        env.MCP_TRANSPORT?.trim().toLowerCase() === 'http'
    if (!http) return { mode: 'stdio' }
    const host =
        flagValue(argv, '--host') ?? env.MCP_HTTP_HOST?.trim() ?? '127.0.0.1'
    const portRaw = flagValue(argv, '--port') ?? env.MCP_HTTP_PORT?.trim()
    const port = portRaw ? Number(portRaw) : defaults.port
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(
            `HTTP port must be an integer 0-65535 (got "${portRaw}")`,
        )
    }
    const token = env.MCP_HTTP_TOKEN?.trim() || undefined
    if (!isLoopbackHost(host) && !token) {
        throw new Error(
            `Refusing to listen on ${host} without MCP_HTTP_TOKEN: anyone who can reach the port would get your Yandex data. ` +
                'Set MCP_HTTP_TOKEN, or keep the default 127.0.0.1.',
        )
    }
    return { mode: 'http', host, port, token }
}

export interface HttpServerHandle {
    url: string
    close(): Promise<void>
}

export interface HttpServeOptions {
    host: string
    port: number
    token?: string
    path?: string
    idleMs?: number
}

function sendJson(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message },
            id: null,
        }),
    )
}

function hostnameOf(value: string): string | undefined {
    try {
        return new URL(value.includes('://') ? value : `http://${value}`)
            .hostname
    } catch {
        return undefined
    }
}

function tokenMatches(header: string | undefined, token: string): boolean {
    const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '')
    const want = Buffer.from(token)
    return given.length === want.length && timingSafeEqual(given, want)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req as AsyncIterable<Buffer>) {
        size += chunk.length
        if (size > MAX_BODY_BYTES) throw new Error('Request body too large')
        chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    return text ? (JSON.parse(text) as unknown) : undefined
}

// One McpServer per session (elicitation needs its own channel); callers share the API client across them.
export async function serveHttp(
    createSession: () => McpServer,
    opts: HttpServeOptions,
): Promise<HttpServerHandle> {
    const path = opts.path ?? '/mcp'
    const loopback = isLoopbackHost(opts.host)
    if (!loopback && !opts.token) {
        throw new Error(`Refusing to listen on ${opts.host} without a token.`)
    }
    const sessions = new Map<
        string,
        { transport: StreamableHTTPServerTransport; lastSeen: number }
    >()
    const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS

    async function handle(
        req: IncomingMessage,
        res: ServerResponse,
    ): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname !== path) return sendJson(res, 404, 'Not found')

        // DNS rebinding: a page on another site must not reach a loopback server through a hostname it controls.
        if (loopback) {
            const host = hostnameOf(req.headers.host ?? '')
            if (!host || !isLoopbackHost(host))
                return sendJson(res, 403, 'Forbidden host')
            const origin = req.headers.origin
            if (origin && !isLoopbackHost(hostnameOf(origin) ?? '')) {
                return sendJson(res, 403, 'Forbidden origin')
            }
        }
        if (
            opts.token &&
            !tokenMatches(req.headers.authorization, opts.token)
        ) {
            return sendJson(res, 401, 'Unauthorized')
        }

        const sessionId = req.headers['mcp-session-id']
        const id = Array.isArray(sessionId) ? sessionId[0] : sessionId
        const body = req.method === 'POST' ? await readBody(req) : undefined

        if (id) {
            const session = sessions.get(id)
            if (!session)
                return sendJson(res, 404, 'Unknown or expired session')
            session.lastSeen = Date.now()
            return session.transport.handleRequest(req, res, body)
        }
        if (req.method !== 'POST' || !isInitializeRequest(body)) {
            return sendJson(
                res,
                400,
                'Missing mcp-session-id; start with an initialize request',
            )
        }

        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: sid => {
                sessions.set(sid, { transport, lastSeen: Date.now() })
            },
        })
        transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId)
        }
        await createSession().connect(transport)
        await transport.handleRequest(req, res, body)
    }

    const server = createHttpServer((req, res) => {
        handle(req, res).catch((err: unknown) => {
            if (!res.headersSent) {
                sendJson(
                    res,
                    400,
                    err instanceof Error ? err.message : String(err),
                )
            }
        })
    })
    const sweep = setInterval(
        () => {
            const cutoff = Date.now() - idleMs
            for (const [sid, s] of sessions) {
                if (s.lastSeen < cutoff) {
                    sessions.delete(sid)
                    void s.transport.close()
                }
            }
        },
        Math.min(idleMs, 60_000),
    )
    sweep.unref()

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(opts.port, opts.host, () => resolve())
    })
    const { port } = server.address() as AddressInfo
    const shownHost = opts.host.includes(':') ? `[${opts.host}]` : opts.host
    return {
        url: `http://${shownHost}:${port}${path}`,
        async close() {
            clearInterval(sweep)
            await Promise.all(
                [...sessions.values()].map(s => s.transport.close()),
            )
            sessions.clear()
            await new Promise<void>(resolve => server.close(() => resolve()))
        },
    }
}
