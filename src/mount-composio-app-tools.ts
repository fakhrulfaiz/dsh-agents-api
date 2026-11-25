/**
 * Plain tools for the connected-app actions people ask for most (reading Gmail and Google Calendar), so the agent
 * does not have to search Composio's catalogue, read schemas and choose fields each time. Each one runs one Composio
 * tool through `COMPOSIO_MULTI_EXECUTE_TOOL` with light defaults fixed here (metadata only, ten newest by default),
 * as a nested call through the normal tool pipeline: the agent's app grants, the write approvals and the guards that
 * apply to that Composio tool apply to this call too. Every other app still uses the search-and-run tools.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { checkComposioCall, type AgentAppGrants } from './composio-grants.ts'

const OUT_MAX = 24_000

type Args = Record<string, unknown>
interface AppTool {
  name: string
  slug: string
  description: string
  properties: Record<string, unknown>
  required?: string[]
  /** The Composio tool's arguments for the model's input. */
  args(input: Args): Record<string, unknown>
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' ? String(v) : undefined)
const count = (v: unknown, fallback: number, max: number): number => {
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : Number(v)
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : fallback
}
const isoTime = (v: unknown): string | undefined => {
  const raw = str(v)
  if (raw === undefined) return undefined
  const at = Date.parse(raw)
  return Number.isNaN(at) ? raw : new Date(at).toISOString()
}
const ACCOUNT = { account: { type: 'string', description: 'Connected account id, only when the user has several accounts of this app.' } }

export const APP_TOOLS: readonly AppTool[] = [
  {
    name: 'gmail_search_emails',
    slug: 'GMAIL_FETCH_EMAILS',
    description: 'Search the user\'s Gmail and return light metadata (sender, subject, time, labels), newest first. Use Gmail search words in query (is:unread, from:ada@example.com, subject:invoice, newer_than:7d, after:2026/10/01, in:inbox). Returns 10 by default, at most 50; if there are more the result has a nextPageToken, but do not page through everything unless the user asks. Read a message with gmail_read_email.',
    properties: {
      query: { type: 'string', description: 'Gmail search, for example "is:unread in:inbox" or "from:ada@example.com newer_than:7d".' },
      max_results: { type: 'integer', minimum: 1, maximum: 50, description: 'How many messages, 1 to 50. Default 10.' },
      page_token: { type: 'string', description: 'The nextPageToken of an earlier search, for the next page.' },
    },
    args: (i) => ({ user_id: 'me', query: str(i['query']) ?? '', max_results: count(i['max_results'], 10, 50), include_payload: false, verbose: false, ...(str(i['page_token']) ? { page_token: str(i['page_token']) } : {}) }),
  },
  {
    name: 'gmail_read_email',
    slug: 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
    description: 'Read one Gmail message: headers and text. message_id comes from gmail_search_emails.',
    properties: { message_id: { type: 'string', description: 'The message id.' } },
    required: ['message_id'],
    args: (i) => ({ user_id: 'me', message_id: str(i['message_id'] ?? i['id']) ?? '', format: 'full' }),
  },
  {
    name: 'gmail_read_email_thread',
    slug: 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID',
    description: 'Read a whole Gmail conversation, every message in it. thread_id comes from gmail_search_emails.',
    properties: { thread_id: { type: 'string', description: 'The thread id.' } },
    required: ['thread_id'],
    args: (i) => ({ user_id: 'me', thread_id: str(i['thread_id'] ?? i['id']) ?? '' }),
  },
  {
    name: 'googlecalendar_list_events',
    slug: 'GOOGLECALENDAR_EVENTS_LIST',
    description: 'List events on the user\'s Google Calendar between two times, earliest first. Times are ISO 8601, for example 2026-10-28T09:00:00+01:00. Default window starts now.',
    properties: {
      time_min: { type: 'string', description: 'Start of the window. Default now.' },
      time_max: { type: 'string', description: 'End of the window.' },
      calendar_id: { type: 'string', description: 'A calendar id from googlecalendar_list_calendars. Default the primary calendar.' },
      max_results: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 25.' },
    },
    args: (i) => ({
      calendarId: str(i['calendar_id']) ?? 'primary',
      timeMin: isoTime(i['time_min']) ?? new Date().toISOString(),
      ...(isoTime(i['time_max']) ? { timeMax: isoTime(i['time_max']) } : {}),
      singleEvents: true, orderBy: 'startTime', maxResults: count(i['max_results'], 25, 100),
    }),
  },
  {
    name: 'googlecalendar_list_calendars',
    slug: 'GOOGLECALENDAR_LIST_CALENDARS',
    description: 'List the user\'s Google calendars with each one\'s id.',
    properties: {},
    args: () => ({}),
  },
]

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties: { ...properties, ...ACCOUNT }, ...(required.length > 0 ? { required } : {}), additionalProperties: false,
})

/** The plain content text of a tool result. */
function textOf(result: { content?: ReadonlyArray<{ type?: string; text?: string }> }): string {
  return (result.content ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
}

/**
 * The one tool's data from `COMPOSIO_MULTI_EXECUTE_TOOL`'s answer, or an error message. The answer is a JSON body
 * `{ successful, data: { results: [{ tool_slug, response: { successful, data | data_preview, error } }] } }`.
 */
export function unwrapAnswer(slug: string, text: string): { data: unknown } | { error: string } {
  let body: { successful?: boolean; error?: unknown; data?: { results?: Array<{ tool_slug?: string; response?: { successful?: boolean; error?: unknown; data?: unknown; data_preview?: unknown } }> } }
  try {
    body = JSON.parse(text) as typeof body
  } catch {
    return { error: text.slice(0, 300) || `${slug}: no answer` }
  }
  if (body.successful === false) return { error: String(body.error ?? `${slug} failed`).slice(0, 300) }
  const entry = body.data?.results?.find((r) => r.tool_slug === slug) ?? body.data?.results?.[0]
  const response = entry?.response
  if (!response) return { error: `${slug}: the answer had no result` }
  if (response.successful === false) return { error: String(response.error ?? `${slug} failed`).slice(0, 300) }
  if (!('data' in response)) return { error: 'the answer was too large and came back shortened; ask for fewer items' }
  return { data: response.data }
}

/**
 * Registers the app tools on an agent scope.
 * @param agentCtx - agent-scoped Cordis context.
 * @param deps - the MCP server label of the Composio tools (`composio`) and the agent's app grants; a tool whose app the agent may not use is not offered.
 */
export function mountComposioAppTools(agentCtx: Context, deps: { serverLabel: string; grants: AgentAppGrants | null }): void {
  const multi = `mcp__${deps.serverLabel}__COMPOSIO_MULTI_EXECUTE_TOOL`
  for (const app of APP_TOOLS) {
    if (checkComposioCall('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: app.slug }] }, deps.grants) !== undefined) continue
    const definition = {
      name: app.name,
      description: app.description,
      parameters: object(app.properties, app.required),
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }],
      },
      async execute(rawArgs: unknown, exec: { callId: string; signal: AbortSignal; agent?: unknown; toolSet?: unknown }) {
        const input = (rawArgs ?? {}) as Args
        const account = str(input['account'])
        const call = {
          type: 'tool-call',
          id: `${exec.callId}:${app.name}`,
          name: multi,
          arguments: { tools: [{ tool_slug: app.slug, arguments: app.args(input), ...(account ? { account } : {}) }] },
        }
        const tools = agentCtx.tools as unknown as { execute(input: Record<string, unknown>): Promise<{ results: Array<{ result: { isError: boolean; content?: Array<{ type?: string; text?: string }> } }> }> }
        const batch = await tools.execute({ calls: [call], signal: exec.signal, agent: exec.agent, toolSet: exec.toolSet, maxParallelToolCalls: 1 })
        const result = batch.results[0]?.result
        if (!result) return JSON.stringify({ error: `${app.name}: no answer` })
        const text = textOf(result)
        // A refusal (grants, approval declined) or an error comes back as the nested call's own text.
        if (result.isError) return JSON.stringify({ error: text.slice(0, 500) || `${app.name} failed` })
        const unwrapped = unwrapAnswer(app.slug, text)
        if ('error' in unwrapped) return JSON.stringify({ error: unwrapped.error })
        const out = JSON.stringify(unwrapped.data)
        return out.length > OUT_MAX ? `${out.slice(0, OUT_MAX)}\n[cut: ${String(out.length - OUT_MAX)} more characters; ask for fewer or narrow the search]` : out
      },
    } as unknown as ToolDefinition
    agentCtx.tools.register(definition)
  }
}
