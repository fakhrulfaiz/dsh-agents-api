/**
 * Print a new API key once, plus the `auth.apiKeys` entry that holds its hash.
 * Writes no files.
 *
 * Usage: pnpm keys:create --name <name> --owner <owner> [--admin]
 */

import { generateApiKey, hashApiKey } from '../src/auth/api-keys.ts'

const USAGE = 'Usage: pnpm keys:create --name <name> --owner <owner> [--admin]'

/** Parsed command line. */
interface Args {
  name: string
  owner: string
  admin: boolean
}

/**
 * Parse the command line strictly: `--name` and `--owner` take a value, `--admin` is a flag, anything else is an error.
 * @param argv - arguments after the script name.
 * @returns the parsed arguments.
 * @throws Error naming the first problem.
 */
function parseArgs(argv: readonly string[]): Args {
  let name: string | undefined
  let owner: string | undefined
  let admin = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--admin') {
      admin = true
    } else if (arg === '--name' || arg === '--owner') {
      const value = argv[i + 1]
      if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      i += 1
      if (arg === '--name') name = value
      else owner = value
    } else {
      throw new Error(`unknown argument "${arg}"`)
    }
  }
  if (name === undefined) throw new Error('--name is required')
  if (owner === undefined) throw new Error('--owner is required')
  return { name, owner, admin }
}

/**
 * Quote a YAML scalar when it is not plain-safe.
 * @param value - scalar text.
 * @returns the text, single-quoted when it contains YAML-significant characters.
 */
function yamlScalar(value: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/.test(value) ? value : `'${value.replaceAll("'", "''")}'`
}

try {
  const args = parseArgs(process.argv.slice(2))
  const key = generateApiKey()
  const roles = args.admin ? 'agentry-user, agentry-admin' : 'agentry-user'
  process.stdout.write([
    `API key (shown once, store it now): ${key}`,
    '',
    'Add this entry to auth.apiKeys in cordis.yml:',
    `- name: ${yamlScalar(args.name)}`,
    `  owner: ${yamlScalar(args.owner)}`,
    `  roles: [${roles}]`,
    `  hash: ${hashApiKey(key)}`,
    '',
  ].join('\n'))
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`)
  process.exitCode = 1
}
