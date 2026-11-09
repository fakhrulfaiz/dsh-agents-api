/**
 * Routes `schedule/resolve-agent` to the Agents API for sessions it owns, so a
 * scheduled delivery runs on the session's Agentry agent setup and reaches its
 * wire projection and status writes.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-schedule'

/**
 * Register the `schedule/resolve-agent` waterfall listener as an effect of `ctx`.
 *
 * The listener answers with `resolve(sessionId)` when it returns an agent and
 * calls `next()` when it returns `undefined`, so sessions this API does not own
 * keep the Host resolver. A rejection from `resolve` rejects the delivery and is
 * not passed to `next()`.
 * @param ctx - plugin context; disposing it removes the listener.
 * @param resolve - live agent of an owned session, or `undefined` for an id the API does not own.
 */
export function installScheduleResolver(ctx: Context, resolve: (sessionId: string) => Promise<Agent | undefined>): void {
  ctx.effect(
    () => ctx.on('schedule/resolve-agent', async (sessionId, next) => await resolve(sessionId) ?? await next()),
    'agents-api: schedule/resolve-agent',
  )
}
