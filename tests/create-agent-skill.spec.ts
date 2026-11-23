import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const text = readFileSync(new URL('../skills/create-agent/SKILL.md', import.meta.url), 'utf8')
const [, frontmatter = '', body = ''] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) ?? []

describe('create-agent skill', () => {
  it('has the frontmatter a skill provider needs', () => {
    expect(frontmatter).toMatch(/^name: create-agent$/m)
    expect(frontmatter).toMatch(/^description: \S/m)
    expect(frontmatter).toMatch(/^user-invocable: true$/m)
  })

  it('names the tools it relies on', () => {
    for (const name of ['ask_user_question', 'agent_tools', 'mcp_servers', 'agent_list', 'agent_get', 'agent_create', 'agent_update', 'COMPOSIO_MANAGE_CONNECTIONS']) {
      expect(body, name).toContain(name)
    }
  })

  it('checks app status with list, never the default add action', () => {
    expect(body).toMatch(/action `list`/)
    expect(body).toMatch(/never use the default `add` action/i)
  })

  it('reports connected, unneeded and missing apps, and covers the no-MCP case', () => {
    expect(body).toMatch(/Connected and useful/)
    expect(body).toMatch(/Connected, probably not needed/)
    expect(body).toMatch(/Not connected but would help/)
    expect(body).toMatch(/no MCP servers at all/i)
    expect(body).toMatch(/Connectors/)
  })

  it('shows a draft and gets a yes before saving', () => {
    expect(body).toMatch(/Show the draft and get a yes/)
    expect(body).toMatch(/Do not save before that/)
  })

  it('never has the model handle keys, credentials or servers', () => {
    expect(body).toMatch(/cannot .*add MCP servers, or put keys or credentials/)
    expect(body).not.toMatch(/credential_id/)
    expect(body).not.toMatch(/api[_ -]?key/i)
  })
})
