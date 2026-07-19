import { randomBytes } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { openBrowser } from '../auth/browser.js'
import { oauthClientConfig, type YandexAuthConfig } from '../auth/config.js'
import { startLoopback } from '../auth/loopback.js'
import {
    buildAuthorizeUrl,
    exchangeCode,
    OOB_REDIRECT_URI,
    type OAuthClientConfig,
    type TokenSet,
} from '../auth/oauth.js'
import { generatePkce } from '../auth/pkce.js'
import type { TokenProvider } from '../auth/provider.js'
import type { TokenStore } from '../auth/tokenStore.js'
import { errorResult, toToolResult } from './result.js'

// Loopback path blocks this tool call until the browser round-trips; bound it
// so a never-completed approval fails cleanly instead of hanging forever.
const LOOPBACK_WAIT_MS = 120_000

function base64Url(buf: Buffer): string {
    return buf
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
}

export interface LoginToolDeps {
    config: YandexAuthConfig
    provider: TokenProvider
    store: TokenStore
}

// A copy-paste sign-in awaiting its code. In-process, single-user, so a lone
// module-level slot is enough; a new `login` overwrites any stale attempt.
interface PendingLogin {
    verifier: string
    redirectUri: string
    oauth: OAuthClientConfig
}
let pending: PendingLogin | null = null

const SIGNED_IN = {
    signed_in: true,
    message: 'Signed in to Yandex. You can run the data tools now.',
}

function adopt(deps: LoginToolDeps, tokens: TokenSet): void {
    deps.store.write(tokens)
    deps.provider.setTokens?.(tokens)
}

/** Register the `login` + `submit_code` tools, owning token persistence. */
export function registerLoginTools(
    server: McpServer,
    deps: LoginToolDeps,
): void {
    const oauth = oauthClientConfig(deps.config)
    const { scope, loopbackPort } = deps.config

    server.registerTool(
        'login',
        {
            title: 'Sign in to Yandex',
            description:
                'Sign in to Yandex from here. Opens your browser to approve access; the code returns ' +
                'automatically over a local redirect, so this usually finishes in one call. If the local port is ' +
                'unavailable it returns a URL to approve and you then call submit_code with the code Yandex shows. ' +
                'Run this once (the token lasts ~1 year); needed before the data tools if you are not signed in yet.',
            inputSchema: {
                oob: z
                    .boolean()
                    .optional()
                    .describe(
                        'Force the copy-paste flow instead of the automatic local redirect.',
                    ),
            },
            annotations: {
                title: 'Sign in to Yandex',
                readOnlyHint: false,
                openWorldHint: true,
            },
        },
        async args => {
            try {
                const pkce = generatePkce()
                const state = base64Url(randomBytes(16))

                if (!args.oob) {
                    let listener
                    try {
                        listener = await startLoopback({
                            port: loopbackPort,
                            state,
                            timeoutMs: LOOPBACK_WAIT_MS,
                        })
                    } catch {
                        listener = null
                    }
                    if (listener) {
                        const url = buildAuthorizeUrl(oauth, {
                            codeChallenge: pkce.challenge,
                            scope,
                            redirectUri: listener.redirectUri,
                            state,
                        })
                        openBrowser(url)
                        try {
                            const code = await listener.code
                            const tokens = await exchangeCode(oauth, {
                                code,
                                codeVerifier: pkce.verifier,
                                redirectUri: listener.redirectUri,
                            })
                            adopt(deps, tokens)
                            pending = null
                            return toToolResult({ ...SIGNED_IN })
                        } finally {
                            listener.close()
                        }
                    }
                }

                // Copy-paste fallback: hand back the URL and await submit_code.
                const url = buildAuthorizeUrl(oauth, {
                    codeChallenge: pkce.challenge,
                    scope,
                    redirectUri: OOB_REDIRECT_URI,
                    state,
                })
                pending = {
                    verifier: pkce.verifier,
                    redirectUri: OOB_REDIRECT_URI,
                    oauth,
                }
                openBrowser(url)
                return toToolResult({
                    signed_in: false,
                    authorize_url: url,
                    next: 'Open authorize_url, approve access, then call submit_code with the code Yandex shows you.',
                })
            } catch (err) {
                return errorResult(err)
            }
        },
    )

    server.registerTool(
        'submit_code',
        {
            title: 'Submit the Yandex sign-in code',
            description:
                'Complete a copy-paste sign-in started by login: pass the code Yandex showed you after you approved access.',
            inputSchema: {
                code: z
                    .string()
                    .min(1)
                    .describe(
                        'The code shown on the Yandex page after you approved access.',
                    ),
            },
            annotations: {
                title: 'Submit the Yandex sign-in code',
                readOnlyHint: false,
                openWorldHint: true,
            },
        },
        async args => {
            try {
                if (!pending) {
                    return errorResult(
                        new Error(
                            'No sign-in is in progress. Call login first, then submit_code with the code.',
                        ),
                    )
                }
                const tokens = await exchangeCode(pending.oauth, {
                    code: args.code.trim(),
                    codeVerifier: pending.verifier,
                    redirectUri: pending.redirectUri,
                })
                adopt(deps, tokens)
                pending = null
                return toToolResult({ ...SIGNED_IN })
            } catch (err) {
                return errorResult(err)
            }
        },
    )
}
