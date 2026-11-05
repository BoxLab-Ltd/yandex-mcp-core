import { createHash, randomBytes } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
    ErrorCode,
    McpError,
    type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import { toToolResult } from './result.js'

const DEFAULT_TTL_MS = 10 * 60_000

export interface MutationPreview {
    tool: string
    summary: string
    request: Record<string, unknown>
}

export type Confirmation =
    { confirmed: true } | { confirmed: false; result: CallToolResult }

export interface MutationConfirmer {
    confirm(
        preview: MutationPreview,
        confirmToken?: string,
    ): Promise<Confirmation>
}

export interface ConfirmerOptions {
    ttlMs?: number
    now?: () => number
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
        return `{${entries.join(',')}}`
    }
    return JSON.stringify(value)
}

function fingerprint(preview: MutationPreview): string {
    return createHash('sha256')
        .update(`${preview.tool}\n${canonical(preview.request)}`)
        .digest('hex')
}

function supportsFormElicitation(server: McpServer): boolean {
    const e = server.server.getClientCapabilities()?.elicitation
    // An empty `elicitation: {}` predates the form/url split and means form.
    return !!e && (e.form !== undefined || e.url === undefined)
}

export function createMutationConfirmer(
    server: McpServer,
    opts: ConfirmerOptions = {},
): MutationConfirmer {
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    const now = opts.now ?? (() => Date.now())
    const issued = new Map<string, { fingerprint: string; expiresAt: number }>()

    function prune(): void {
        const t = now()
        for (const [token, entry] of issued) {
            if (entry.expiresAt <= t) issued.delete(token)
        }
    }

    function pending(preview: MutationPreview, note?: string): Confirmation {
        const token = randomBytes(12).toString('base64url')
        issued.set(token, {
            fingerprint: fingerprint(preview),
            expiresAt: now() + ttlMs,
        })
        return {
            confirmed: false,
            result: toToolResult({
                confirmed: false,
                summary: preview.summary,
                request: preview.request,
                confirm_token: token,
                expires_in_s: Math.round(ttlMs / 1000),
                ...(note ? { note } : {}),
                next:
                    'Nothing has been changed yet. Show the user this summary and ask whether to apply it. ' +
                    `Only after they agree, call ${preview.tool} again with the same arguments plus confirmToken.`,
            }),
        }
    }

    async function elicit(
        preview: MutationPreview,
    ): Promise<Confirmation | null> {
        let action: string
        try {
            const answer = await server.server.elicitInput(
                {
                    mode: 'form',
                    message: `${preview.summary}\n\nApply this change?`,
                    requestedSchema: { type: 'object', properties: {} },
                },
                { timeout: ttlMs },
            )
            action = answer.action
        } catch (err) {
            // A timeout or failed prompt must never become an approval; only "cannot elicit" falls back.
            if (
                err instanceof McpError &&
                err.code === ErrorCode.MethodNotFound
            ) {
                return null
            }
            action = 'failed'
        }
        if (action === 'accept') return { confirmed: true }
        return {
            confirmed: false,
            result: toToolResult({
                confirmed: false,
                summary: preview.summary,
                message:
                    action === 'failed'
                        ? 'The confirmation prompt failed or timed out, so nothing was changed.'
                        : 'The user did not approve this change, so nothing was changed. Do not retry unless they ask.',
            }),
        }
    }

    return {
        async confirm(preview, confirmToken) {
            prune()
            if (supportsFormElicitation(server)) {
                const asked = await elicit(preview)
                if (asked) return asked
            }
            if (confirmToken === undefined) return pending(preview)
            const entry = issued.get(confirmToken)
            if (!entry) {
                return pending(
                    preview,
                    'That confirm_token is unknown, used or expired; here is a fresh one.',
                )
            }
            issued.delete(confirmToken)
            if (entry.fingerprint !== fingerprint(preview)) {
                return pending(
                    preview,
                    'The arguments changed since the token was issued; confirm this new request instead.',
                )
            }
            return { confirmed: true }
        },
    }
}
