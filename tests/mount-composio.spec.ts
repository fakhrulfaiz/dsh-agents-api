/** Composio guard, send approvals, and guidance on an agent scope. */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { COMPOSIO_GUIDANCE_TEXT, mountComposio } from '../src/mount-composio.ts'

type Exec = { name: string; arguments: unknown }
function fake() {
  let guard: ((exec: Exec) => string | undefined) | undefined
  let pre: ((exec: Exec, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  let post: ((exec: Exec, result: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  let section: { name: string; text: (ctx: unknown) => string } | undefined
  const ctx = {
    tools: { guard: (g: typeof guard) => { guard = g } },
    on: (e: string, h: never) => { if (e === 'tools/post-execute') post = h; else pre = h },
    get: (name: string) => (name === 'systemPrompt' ? {} : undefined),
    systemPrompt: { section: (s: typeof section) => { section = s } },
  } as unknown as Context
  return { ctx, guard: (e: Exec) => guard!(e), post: (e: Exec, result: unknown) => post!(e, result, () => Promise.resolve({ kind: 'accept' })), pre: (e: Exec) => (pre ? pre(e, () => Promise.resolve('passed')) : Promise.resolve('passed')), section: () => section! }
}
const deps = (extra: object = {}) => ({ grants: { gmail: 'all' as const }, approvalVerbs: new Set(['SEND']), approvalSlugs: new Set<string>(), sendPolicy: 'ask' as const, serverLabel: 'composio', ...extra })

describe('mountComposio', () => {
  it('guards only this server prefix', () => {
    const f = fake()
    mountComposio(f.ctx, deps())
    expect(f.guard({ name: 'mcp__composio__SLACK_SEND_MESSAGE', arguments: {} })).toMatch(/Slack/iu)
    expect(f.guard({ name: 'mcp__composio__GMAIL_SEND_EMAIL', arguments: {} })).toBeUndefined()
    expect(f.guard({ name: 'bash', arguments: {} })).toBeUndefined()
  })

  it('asks before a write under policy ask, inside a batch too; passes reads and policy auto', async () => {
    const f = fake()
    mountComposio(f.ctx, deps())
    expect(await f.pre({ name: 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL', arguments: { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'a@b.c' } }] } })).toMatchObject({ kind: 'ask' })
    expect(await f.pre({ name: 'mcp__composio__GMAIL_FETCH_EMAILS', arguments: {} })).toBe('passed')
    const auto = fake()
    mountComposio(auto.ctx, deps({ sendPolicy: 'auto' }))
    expect(await auto.pre({ name: 'mcp__composio__GMAIL_SEND_EMAIL', arguments: {} })).toBe('passed')
  })

  it('guidance appears only when composio tools are in the step', () => {
    const f = fake()
    mountComposio(f.ctx, deps())
    const view = (names: string[]) => ({ scope: {}, toolSet: { view: () => new Map(names.map(n => [n, {}])) } })
    expect(f.section().text(view(['bash']))).toBe('')
    expect(f.section().text(view(['mcp__composio__COMPOSIO_SEARCH_TOOLS']))).toBe(COMPOSIO_GUIDANCE_TEXT)
  })

  it('trims search results to the apps the agent may use', async () => {
    const f = fake()
    mountComposio(f.ctx, deps())
    const body = { successful: true, data: { results: [{ primary_tool_slugs: ['GMAIL_FETCH_EMAILS', 'SLACK_SEND_MESSAGE'], toolkit_connection_statuses: [{ toolkit: 'gmail', connected: true }, { toolkit: 'slack', connected: true }] }], tool_schemas: { GMAIL_FETCH_EMAILS: {}, SLACK_SEND_MESSAGE: {} } } }
    const result = { isError: false, content: [{ type: 'text', text: JSON.stringify(body) }] }
    const out = await f.post({ name: 'mcp__composio__COMPOSIO_SEARCH_TOOLS', arguments: {} }, result) as { kind: string; content: { text: string }[] }
    expect(out.kind).toBe('accept')
    expect(JSON.parse(out.content[0]!.text)).toEqual({ successful: true, data: { results: [{ primary_tool_slugs: ['GMAIL_FETCH_EMAILS'], toolkit_connection_statuses: [{ toolkit: 'gmail', connected: true }] }], tool_schemas: { GMAIL_FETCH_EMAILS: {} } } })
    // other tools, errors and unrestricted agents are untouched
    expect(await f.post({ name: 'mcp__composio__GMAIL_FETCH_EMAILS', arguments: {} }, result)).toEqual({ kind: 'accept' })
    expect(await f.post({ name: 'mcp__composio__COMPOSIO_SEARCH_TOOLS', arguments: {} }, { ...result, isError: true })).toEqual({ kind: 'accept' })
    const open = fake()
    mountComposio(open.ctx, deps({ grants: null }))
    expect(() => open.post({ name: 'x', arguments: {} }, result)).toThrow()
  })
})
