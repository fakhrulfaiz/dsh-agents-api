import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ImportError, parseAgentDefinition } from '../src/agent-import/parse.ts'

const CATALOG = new Set(['read', 'write', 'edit', 'grep', 'glob', 'bash', 'web_fetch', 'web_search', 'todo_write', 'skill'])
const fixture = (name: string) => readFileSync(new URL(`./fixtures/agents/${name}`, import.meta.url), 'utf8')
const md = (front: string, body = 'You review code.') => `---\n${front}\n---\n\n${body}\n`

describe('agent import parser', () => {
  it('reads an ECC agent file: title-cased name, body as instructions, tools mapped, model noted', () => {
    const { draft, format, notes } = parseAgentDefinition(fixture('code-reviewer.md'), CATALOG)
    expect(format).toBe('ecc')
    expect(draft.name).toBe('Code reviewer')
    expect(draft.instructions?.startsWith('## Prompt Defense Baseline')).toBe(true)
    expect(draft.metadata?.['description']).toMatch(/^Expert code review specialist/)
    expect(draft.host_tools).toEqual({ allow: ['read', 'grep', 'glob', 'bash'] })
    expect(draft.model).toBeUndefined()
    expect(notes.join(' ')).toMatch(/model "sonnet"/)
    expect(parseAgentDefinition(fixture('planner.md'), CATALOG).draft.host_tools).toEqual({ allow: ['read', 'grep', 'glob'] })
  })

  it('takes a YAML tool list, turns Task into subagents and drops unknown tools with a note', () => {
    const { draft, notes } = parseAgentDefinition(md('name: helper\ndescription: d\ntools:\n  - Read\n  - Task\n  - NotebookEdit\n  - TodoWrite'), new Set(['read']))
    expect(draft.host_tools).toEqual({ allow: ['read'] })
    expect(draft.multi_agent).toEqual({ enabled: true })
    expect(notes).toContain('Dropped tools this server does not have: NotebookEdit, TodoWrite.')
  })

  it('reads Agentry library hints: title, subagents, browser and apps', () => {
    const { draft } = parseAgentDefinition(md('name: e2e-runner\ntitle: E2E runner\ndescription: d\ntools: read, bash\nsubagents: true\nbrowser: true\napps: gmail, googlecalendar'), CATALOG)
    expect(draft).toMatchObject({ name: 'E2E runner', host_tools: { allow: ['read', 'bash'] }, multi_agent: { enabled: true }, browser: true, apps: { gmail: 'all', googlecalendar: 'all' } })
  })

  it('sets no tool mask without a tools line', () => {
    expect(parseAgentDefinition(md('name: helper\ndescription: d'), CATALOG).draft.host_tools).toBeUndefined()
  })

  it('reads Agentry JSON, dropping ids, timestamps and masked MCP tools', () => {
    const { draft, format, notes } = parseAgentDefinition(JSON.stringify({
      id: 'agent_x', object: 'agent', created_at: 1, updated_at: 2, name: 'Mailer', instructions: 'Hi', model: 'deepseek-flash',
      apps: { gmail: 'all' }, send_policy: 'ask', host_tools: { allow: ['read', 'nope'] },
      tools: [{ type: 'mcp', server_label: 'x', transport: { type: 'http', server_url: 'https://e.com', headers: { k: '***' } } }],
    }), CATALOG)
    expect(format).toBe('agentry')
    expect(draft).toEqual({ name: 'Mailer', instructions: 'Hi', model: 'deepseek-flash', apps: { gmail: 'all' }, send_policy: 'ask', host_tools: { allow: ['read'] } })
    expect(notes.join(' ')).toMatch(/nope/)
    expect(notes.join(' ')).toMatch(/Left out 1 MCP server/)
  })

  it('refuses text that is not an agent and instructions over 64 KB', () => {
    const code = (fn: () => unknown) => { try { fn(); return 'ok' } catch (e) { return (e as ImportError).code } }
    expect(code(() => parseAgentDefinition('just some notes', CATALOG))).toBe('import_unrecognized')
    expect(code(() => parseAgentDefinition(md('title: x'), CATALOG))).toBe('import_unrecognized')
    expect(code(() => parseAgentDefinition(md('name: big\ndescription: d', 'x'.repeat(65_537)), CATALOG))).toBe('import_too_large')
  })
})
