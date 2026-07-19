import { createInterface } from 'node:readline'
import type { YandexAuthConfig } from './config.js'
import { interactiveLogin } from './login.js'
import { resolveTokenProvider } from './resolve.js'

/** Prompt the user on stdin and resolve with the trimmed answer. */
function prompt(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    return new Promise(resolve => {
        rl.question(question, answer => {
            rl.close()
            resolve(answer.trim())
        })
    })
}

/**
 * Interactive CLI sign-in (authorization-code + PKCE). Loopback by default; the
 * `--oob` flag forces the copy-paste flow. The token is cached (mode 0600).
 * Call from a server's `index.ts` when the `auth` subcommand is given.
 */
export async function runAuthCli(
    config: YandexAuthConfig,
    argv: string[] = process.argv,
    env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
    const { store } = resolveTokenProvider(config, env)
    const tokens = await interactiveLogin(config, {
        forceOob: argv.includes('--oob'),
        log: message => console.log(message),
        promptForCode: async url => {
            console.log('\nTo authorize this server with Yandex:')
            console.log(`  1. Open this URL and approve access:\n     ${url}`)
            console.log(
                '  2. Copy the code Yandex shows you on the next page.\n',
            )
            return prompt('Paste the code here: ')
        },
    })
    store.write(tokens)
    console.log(`\n✓ Signed in. Token saved to ${store.path} (mode 0600).`)
}
