import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { builtinLibrary, readBuiltinFiles } from '../src/agent-import/builtin-library.ts'
import { splitFrontMatter } from '../src/agent-import/parse.ts'
import { AGENT_COLOR_NAMES, AGENT_ICON_NAMES } from '../src/agent-avatar.ts'
import { openAuthenticator } from './open-auth.ts'
import { createLocalProvider } from '../src/environment/local.ts'
import { AgentsGateway } from '../src/gateway.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import { FakeSessionQuery, testGatewayOptions } from './support/fake-session-query.ts'
import { MemoryStore } from './support/memory-store.ts'

/** The server's Host tools (`GET /v1/agents/tools`, 2026-11-28). */
const SERVER_TOOLS = new Set([
  'load_workspace_dependencies', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource', 'working_directory', 'skill', 'present',
  'bash', 'read', 'write', 'edit', 'glob', 'grep', 'job_output', 'job_list', 'job_kill', 'get_goal', 'create_goal', 'update_goal', 'web_search',
  'web_fetch', 'plugin_manager', 'read_image', 'todo_write', 'ask_user_question', 'list_agents', 'send_message', 'interrupt_agent', 'workflow',
  'exit_plan_mode', 'list_subagent_models', 'subagent', 'subagent_fork', 'schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit',
])

const servers: Server[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })

describe('built-in agent Library', () => {
  it('all files parse, credit ECC, use only server tools and known avatars', () => {
    const files = readBuiltinFiles()
    expect(files.length).toBeGreaterThanOrEqual(15)
    const items = builtinLibrary(files, SERVER_TOOLS)
    for (const { file, text } of files) {
      const front = splitFrontMatter(text)!.data
      const item = items.find(i => i.ref === `Agentry:${file}`)!
      expect(front['source'], file).toMatch(/^https:\/\/github\.com\/affaan-m\/ECC\/blob\/main\/agents\/.+\.md$/)
      expect(front['license'], file).toBe('MIT (ECC, Affaan Mustafa)')
      expect(front['model'], file).toBeUndefined()
      expect(item.draft.instructions!.length, file).toBeGreaterThan(500)
      expect(item.draft.instructions, file).not.toMatch(/mcp__|CLAUDE\.md|slash command|PostToolUse|\bopus\b|\bsonnet\b|\bhaiku\b/i)
      // Every listed tool survives the server catalog (nothing was dropped).
      expect(item.draft.host_tools?.allow?.length ?? 0, file).toBe(String(front['tools'] ?? '').split(',').filter(t => t.trim()).length)
      expect(AGENT_ICON_NAMES, file).toContain(item.icon)
      expect(AGENT_COLOR_NAMES, file).toContain(item.color)
    }
    const bySlug = (slug: string) => items.find(i => i.slug === slug)!
    expect(bySlug('e2e-runner')).toMatchObject({ name: 'E2E runner', browser: true, draft: { browser: true, metadata: { icon: 'web', color: 'green' } } })
    expect(bySlug('chief-of-staff').draft.apps).toEqual({ gmail: 'all', googlecalendar: 'all', slack: 'all' })
    expect(bySlug('marketing-agent')).toMatchObject({ subagents: true, draft: { multi_agent: { enabled: true } } })
  })

  it('is served at GET /agents/library/builtin', async () => {
    const ctx = { logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() }, tools: { schemas: () => [] } } as unknown as Context
    const api = new AgentsGateway(ctx, openAuthenticator, '/v1', new MemoryStore(), new SessionRegistry(), testGatewayOptions(createLocalProvider(join(tmpdir(), 'agentry-builtin-library')), new FakeSessionQuery()))
    const server = createServer((req, res) => { void api.handle(req, res) })
    servers.push(server)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const res = await fetch(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1/agents/library/builtin`)
    expect(res.status).toBe(200)
    const body = await res.json() as { object: string; data: Array<{ ref: string; source: string; draft: { name: string } }> }
    expect(body.object).toBe('list')
    expect(body.data.length).toBeGreaterThanOrEqual(15)
    expect(body.data.find(i => i.ref === 'Agentry:planner.md')).toMatchObject({ source: 'Agentry', draft: { name: 'Planner' } })
  })
})
