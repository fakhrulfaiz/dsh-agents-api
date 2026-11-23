import { describe, expect, it } from 'vitest'
import { findMaskedSecret, MASKED_SECRET, redactAgentSecrets, redactSessionSecrets } from '../src/redact.ts'
import type { OAIAgent, OAIAgentSession } from '../src/types.ts'

function agent(): OAIAgent {
  return {
    id: 'agent_1',
    object: 'agent',
    created_at: 1,
    updated_at: 1,
    name: null,
    instructions: null,
    model: 'deepseek-chat',
    metadata: {},
    tools: [
      { type: 'function', name: 'f', parameters: {} } as OAIAgent['tools'][number],
      { type: 'mcp', server_label: 'composio', transport: { type: 'http', server_url: 'https://x.test/mcp', headers: { 'x-consumer-api-key': 'ck_test_secret', Authorization: 'Bearer ck_test_secret' } } },
      { type: 'mcp', server_label: 'local', transport: { type: 'stdio', command: 'node', args: ['srv.js', '--key=public'], env: { API_KEY: 'ck_test_secret' } } },
      { type: 'mcp', server_label: 'bare', transport: { type: 'http', server_url: 'https://y.test' } },
    ],
  }
}

describe('redactAgentSecrets', () => {
  it('masks http header values and stdio env values, keeping names, command, and args', () => {
    const out = redactAgentSecrets(agent())
    expect(out.tools[1]).toMatchObject({ transport: { headers: { 'x-consumer-api-key': MASKED_SECRET, Authorization: MASKED_SECRET }, server_url: 'https://x.test/mcp' } })
    expect(out.tools[2]).toMatchObject({ transport: { command: 'node', args: ['srv.js', '--key=public'], env: { API_KEY: MASKED_SECRET } } })
    expect(out.tools[3]).toEqual(agent().tools[3])
    expect(JSON.stringify(out)).not.toContain('ck_test_secret')
  })

  it('leaves non-mcp tools untouched', () => {
    const out = redactAgentSecrets(agent())
    expect(out.tools[0]).toEqual(agent().tools[0])
  })

  it('does not mutate its input and is idempotent', () => {
    const input = agent()
    const once = redactAgentSecrets(input)
    expect(input).toEqual(agent())
    expect(redactAgentSecrets(once)).toEqual(once)
  })

  it('redacts the agent inside a session without mutating it', () => {
    const session = { id: 's', agent: agent() } as unknown as OAIAgentSession
    const out = redactSessionSecrets(session)
    expect(JSON.stringify(out)).not.toContain('ck_test_secret')
    expect(JSON.stringify(session)).toContain('ck_test_secret')
  })
})

describe('findMaskedSecret', () => {
  it('names a masked header or env entry and ignores real values', () => {
    expect(findMaskedSecret(agent().tools)).toBeUndefined()
    expect(findMaskedSecret(redactAgentSecrets(agent()).tools)).toContain('composio')
    expect(findMaskedSecret([{ type: 'mcp', server_label: 'l', transport: { type: 'stdio', command: 'c', env: { K: '***' } } }])).toContain('env "K"')
  })
})
