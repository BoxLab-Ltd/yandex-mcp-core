import type { YandexAuthConfig } from './config.js'
import type { TokenProvider } from './provider.js'

export class WriteAccessError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'WriteAccessError'
    }
}

export async function assertWriteAccess(
    config: YandexAuthConfig,
    provider: TokenProvider,
): Promise<void> {
    const { writeScope } = config
    if (!config.writeEnabled || !writeScope) {
        throw new WriteAccessError(
            `Write tools are disabled. Set ${config.writeEnv ?? 'the write flag'}=1 in the server's environment to enable them.`,
        )
    }
    await provider.getAccessToken()
    // A static token's scope is unknown: let the API decide.
    if (!provider.grantedScope) return
    // No recorded scope means a login from before write support, i.e. read-only.
    const granted = provider.grantedScope() ?? config.scope
    if (granted.split(/\s+/).includes(writeScope)) return
    throw new WriteAccessError(
        `The current sign-in grants only "${granted}", not "${writeScope}". ` +
            'Sign in again with the `login` tool (or the `auth` command) — it now also asks for write access — then retry.',
    )
}
