/**
 * Composio on an agent scope: enforce the agent's app grants on every
 * `mcp__<server>__*` call, ask before writes on the user's behalf, and tell
 * the model how connections and their errors work.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { checkComposioCall, isWriteSlug, slugsInCall, type AgentAppGrants } from './composio-grants.ts'

export const COMPOSIO_GUIDANCE_SECTION = 'agents-api:composio-guidance'
export const COMPOSIO_GUIDANCE_ORDER = 12
export const COMPOSIO_GUIDANCE_TEXT = 'Connected apps: never write connection or sign-in URLs in your reply; the user sees a Connect button. If an app call fails with 401, USER_NOT_LOGGED_IN, or no connected account, call COMPOSIO_MANAGE_CONNECTIONS for that app so the user can reconnect. If it fails with 403 insufficient scope, tell the user which permission is missing instead of retrying.'

/** Words in a tool slug that mean the call writes on the user's behalf. */
export const DEFAULT_APPROVAL_VERBS: readonly string[] = ['SEND', 'REPLY', 'FORWARD', 'CREATE', 'UPDATE', 'DELETE', 'TRASH', 'REMOVE', 'MOVE', 'MERGE', 'CLOSE', 'SHARE', 'UPLOAD', 'INSERT', 'MODIFY', 'PATCH', 'PUT', 'POST', 'ADD', 'ARCHIVE', 'INVITE', 'ACCEPT', 'DECLINE', 'PUBLISH', 'EXECUTE', 'RUN', 'STAR', 'LABEL']

export interface ComposioMountDeps {
  grants: AgentAppGrants | null
  approvalVerbs: ReadonlySet<string>
  approvalSlugs: ReadonlySet<string>
  /** `ask`: approve each write; `auto`: writes run without asking. */
  sendPolicy: 'ask' | 'auto'
  /** MCP server label of the Composio tools (`composio`). */
  serverLabel: string
}

/**
 * @param agentCtx - agent-scoped context.
 * @param deps - grants, approval rules, policy, and server label.
 */
export function mountComposio(agentCtx: Context, deps: ComposioMountDeps): void {
  const prefix = `mcp__${deps.serverLabel}__`
  agentCtx.tools.guard((exec) => {
    if (!exec.name.startsWith(prefix)) return undefined
    return checkComposioCall(exec.name.slice(prefix.length), exec.arguments, deps.grants)
  })
  if (deps.sendPolicy === 'ask' && typeof (agentCtx as { on?: unknown }).on === 'function') {
    const approve = async (exec: { name: string; arguments: unknown }, next: () => Promise<unknown>): Promise<unknown> => {
      if (!exec.name.startsWith(prefix)) return next()
      const slugs = slugsInCall(exec.name.slice(prefix.length), exec.arguments)
      const writes = slugs === 'malformed' ? [] : slugs.filter(slug => isWriteSlug(slug, deps.approvalVerbs, deps.approvalSlugs))
      if (writes.length === 0) return next()
      const excerpt = JSON.stringify(exec.arguments ?? {}).replace(/\s+/gu, ' ').slice(0, 200)
      const text = `Send on your behalf? ${writes.join(', ')}: ${excerpt}`
      return { kind: 'ask' as const, reason: text, displayReason: { en: text } }
    }
    agentCtx.on('tools/pre-execute', approve as never)
  }
  if (agentCtx.get('systemPrompt') === undefined) return
  agentCtx.systemPrompt.section({
    name: COMPOSIO_GUIDANCE_SECTION,
    order: COMPOSIO_GUIDANCE_ORDER,
    text: (context) => {
      const names = context.toolSet?.view(context.scope)?.keys() ?? []
      for (const name of names) if (name.startsWith(prefix)) return COMPOSIO_GUIDANCE_TEXT
      return ''
    },
  })
}
