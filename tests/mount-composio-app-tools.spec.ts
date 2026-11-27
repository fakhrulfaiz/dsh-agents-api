import { describe, expect, it } from 'vitest'
import { DEFAULT_APPROVAL_VERBS } from '../src/mount-composio.ts'
import { isWriteSlug } from '../src/composio-grants.ts'
import { APP_TOOLS, mountComposioAppTools, unwrapAnswer } from '../src/mount-composio-app-tools.ts'

type Reg = { name: string; execute(args: unknown, exec: unknown): Promise<string> }

function setup(answer: (call: { name: string; arguments: { tools: { tool_slug: string; arguments: Record<string, unknown>; account?: string }[] } }) => { isError: boolean; text: string }, grants: Record<string, 'all' | string[]> | null = null) {
  const registered = new Map<string, Reg>()
  const calls: unknown[] = []
  const ctx = {
    tools: {
      register: (d: Reg) => { registered.set(d.name, d); return () => {} },
      execute: async (input: { calls: { name: string; arguments: never }[] }) => {
        calls.push(input)
        const r = answer(input.calls[0] as never)
        return { results: [{ result: { isError: r.isError, content: [{ type: 'text', text: r.text }] } }] }
      },
    },
  }
  mountComposioAppTools(ctx as never, { serverLabel: 'composio', grants })
  return { registered, calls }
}
const ok = (slug: string, data: unknown) => ({ isError: false, text: JSON.stringify({ successful: true, data: { results: [{ tool_slug: slug, response: { successful: true, data } }] } }) })
const exec = { callId: 'call_1', signal: new AbortController().signal }

describe('Composio app tools', () => {
  it('registers the Gmail and Calendar reads', () => {
    const { registered } = setup(() => ok('X', {}))
    expect([...registered.keys()]).toEqual(APP_TOOLS.map((t) => t.name))
    expect(registered.has('gmail_search_emails')).toBe(true)
  })

  it('runs one Composio tool through the multi-execute tool with light defaults, and returns just its data', async () => {
    const { registered, calls } = setup((c) => ok(c.arguments.tools[0]!.tool_slug, { messages: [{ subject: 'hi' }] }))
    const out = await registered.get('gmail_search_emails')!.execute({ query: 'is:unread' }, exec)
    expect(JSON.parse(out)).toEqual({ messages: [{ subject: 'hi' }] })
    const sent = (calls[0] as { calls: { name: string; arguments: { tools: unknown[] } }[] }).calls[0]!
    expect(sent.name).toBe('mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL')
    expect(sent.arguments.tools).toEqual([{ tool_slug: 'GMAIL_FETCH_EMAILS', arguments: { user_id: 'me', query: 'is:unread', max_results: 10, include_payload: false, verbose: false } }])
  })

  it('clamps the page size, passes the page token and the account', async () => {
    const { registered, calls } = setup((c) => ok(c.arguments.tools[0]!.tool_slug, {}))
    await registered.get('gmail_search_emails')!.execute({ query: '', max_results: 5000, page_token: 'tok', account: 'acct_1' }, exec)
    const tool = (calls[0] as { calls: { arguments: { tools: { arguments: Record<string, unknown>; account?: string }[] } }[] }).calls[0]!.arguments.tools[0]!
    expect(tool.arguments).toMatchObject({ max_results: 50, page_token: 'tok' })
    expect(tool.account).toBe('acct_1')
  })

  it('returns a refusal or failure as an error, and reports a shortened answer', async () => {
    const refused = setup(() => ({ isError: true, text: 'Error: This agent is not allowed to use Gmail (GMAIL_FETCH_EMAILS).' }))
    expect(JSON.parse(await refused.registered.get('gmail_search_emails')!.execute({}, exec))).toEqual({ error: 'Error: This agent is not allowed to use Gmail (GMAIL_FETCH_EMAILS).' })
    expect(unwrapAnswer('S', JSON.stringify({ successful: true, data: { results: [{ tool_slug: 'S', response: { successful: true, data_preview: 'x' } }] } }))).toEqual({ error: 'the answer was too large and came back shortened; ask for fewer items' })
    expect(unwrapAnswer('S', JSON.stringify({ successful: true, data: { results: [{ tool_slug: 'S', response: { successful: false, error: 'boom' } }] } }))).toEqual({ error: 'boom' })
  })

  it('offers only the tools of apps the agent may use', () => {
    const { registered } = setup(() => ok('X', {}), { gmail: 'all' })
    expect([...registered.keys()]).toEqual(APP_TOOLS.filter((t) => t.name.startsWith('gmail_')).map((t) => t.name))
    expect(registered.has('googlecalendar_create_event')).toBe(false)
    expect(setup(() => ok('X', {}), { gmail: ['GMAIL_FETCH_EMAILS'] }).registered.has('gmail_read_email')).toBe(false)
  })

  it('cuts a very large answer with a note', async () => {
    const { registered } = setup((c) => ok(c.arguments.tools[0]!.tool_slug, { text: 'x'.repeat(40_000) }))
    const out = await registered.get('gmail_read_email')!.execute({ message_id: 'm1' }, exec)
    expect(out).toContain('[cut:')
    expect(out.length).toBeLessThan(25_000)
  })

  it('every write tool is a write by the approval rule, so the nested call asks first; reads are not', () => {
    const verbs = new Set(DEFAULT_APPROVAL_VERBS)
    for (const t of APP_TOOLS) expect(isWriteSlug(t.slug, verbs, new Set()), t.name).toBe(t.write === true)
    expect(APP_TOOLS.filter((t) => t.write).map((t) => t.name)).toEqual(['gmail_create_draft', 'gmail_send_email', 'gmail_reply_to_thread', 'googlecalendar_create_event', 'googlecalendar_update_event', 'googlecalendar_delete_event'])
  })

  it('maps write input to the Composio arguments', async () => {
    const { registered, calls } = setup((c) => ok(c.arguments.tools[0]!.tool_slug, { id: 'x' }))
    const sent = () => (calls.at(-1) as { calls: { arguments: { tools: { tool_slug: string; arguments: Record<string, unknown> }[] } }[] }).calls[0]!.arguments.tools[0]!
    await registered.get('gmail_send_email')!.execute({ to: 'a@x.test, b@x.test', subject: 'S', body: 'B', cc: 'c@x.test' }, exec)
    expect(sent()).toEqual({ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { user_id: 'me', recipient_email: 'a@x.test', extra_recipients: ['b@x.test'], subject: 'S', body: 'B', cc: ['c@x.test'] } })
    await registered.get('gmail_create_draft')!.execute({ to: 'a@x.test', subject: 'S', body: 'B', thread_id: 't1' }, exec)
    expect(sent()).toEqual({ tool_slug: 'GMAIL_CREATE_EMAIL_DRAFT', arguments: { user_id: 'me', recipient_email: 'a@x.test', subject: 'S', body: 'B', thread_id: 't1' } })
    await registered.get('googlecalendar_create_event')!.execute({ title: 'Lunch', start: '2026-10-28T12:00:00Z', duration_minutes: 90, attendees: 'a@x.test' }, exec)
    expect(sent().arguments).toMatchObject({ calendar_id: 'primary', summary: 'Lunch', start_datetime: '2026-10-28T12:00:00Z', event_duration_hour: 1, event_duration_minutes: 30, attendees: ['a@x.test'] })
    await registered.get('googlecalendar_delete_event')!.execute({ event_id: 'e1' }, exec)
    expect(sent()).toEqual({ tool_slug: 'GOOGLECALENDAR_DELETE_EVENT', arguments: { calendar_id: 'primary', event_id: 'e1' } })
  })

  it('a declined approval comes back as an error and nothing else runs', async () => {
    const { registered } = setup(() => ({ isError: true, text: 'Denied by the user.' }))
    expect(JSON.parse(await registered.get('gmail_send_email')!.execute({ to: 'a@x.test', subject: 'S', body: 'B' }, exec))).toEqual({ error: 'Denied by the user.' })
  })
})
