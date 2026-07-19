import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { YandexApiError } from '../http/errors.js'

/** Wrap a structured object as a successful tool result (text + structured). */
export function toToolResult(
    structured: Record<string, unknown>,
): CallToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
    }
}

/** A short, actionable next step for the model based on the API error kind. */
function recoveryHint(
    err: YandexApiError,
    resourceNoun: string,
): string | undefined {
    if (err.status === 401 || err.errorTypes.includes('invalid_token')) {
        return (
            'The access token is invalid or expired. Re-authenticate with the ' +
            "`login` tool, or run the server's `auth` command."
        )
    }
    // 403/access_denied is a missing grant, NOT a stale token — re-auth will not
    // help, so do not suggest it here.
    if (err.status === 403 || err.errorTypes.includes('access_denied')) {
        return (
            `Access denied: the token lacks access to this ${resourceNoun}. Grant ` +
            `the account access, or use a ${resourceNoun} you can read.`
        )
    }
    if (err.isThrottled) {
        return (
            'Rate/quota limit hit. Wait a few minutes and retry with fewer parallel ' +
            'calls. Yandex resets its daily quota at 00:00 GMT.'
        )
    }
    if (err.errorTypes.includes('timeout')) {
        return 'The request timed out. Narrow the query, then retry.'
    }
    if (err.errorTypes.includes('network_error')) {
        return 'Network error reaching the Yandex API. Check connectivity and retry.'
    }
    return undefined
}

/**
 * Wrap an error as a tool result the model can read and recover from. Pass a
 * `resourceNoun` (e.g. "counter", "site") to tailor the 403 hint.
 */
export function errorResult(
    err: unknown,
    opts: { resourceNoun?: string } = {},
): CallToolResult {
    const resourceNoun = opts.resourceNoun ?? 'resource'
    if (err instanceof YandexApiError) {
        const hint = recoveryHint(err, resourceNoun)
        const text = hint
            ? `Error: ${err.message}\n${hint}`
            : `Error: ${err.message}`
        return {
            content: [{ type: 'text', text }],
            structuredContent: {
                error: err.message,
                status: err.status,
                error_types: err.errorTypes,
                ...(hint ? { hint } : {}),
            },
            isError: true,
        }
    }
    const message = err instanceof Error ? err.message : String(err)
    return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
    }
}
