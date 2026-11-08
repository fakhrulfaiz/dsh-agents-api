import type { Authenticator } from '../src/auth/authenticator.ts'

/** Test authenticator that accepts every request as owner `test` with the user role. */
export const openAuthenticator: Authenticator = {
  authenticate: () => Promise.resolve({
    ok: true,
    principal: { owner: 'test' as never, roles: new Set(['agentry-user' as const]) },
  }),
}
