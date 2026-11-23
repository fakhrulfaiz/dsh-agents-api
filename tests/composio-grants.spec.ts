/** Composio app grants: legacy reading, call checks, clamping, write detection. */

import { describe, expect, it } from 'vitest'
import { checkComposioCall, clampGrants, effectiveGrants, isWriteSlug, slugsInCall, validateAppGrants } from '../src/composio-grants.ts'
import { materializeAgent } from '../src/agent-records.ts'

const agent = (extra: Record<string, unknown>) => ({ ...materializeAgent({ model: 'm' }), ...extra })

describe('effectiveGrants', () => {
  it('uses apps when set', () => {
    expect(effectiveGrants(agent({ apps: { gmail: ['GMAIL_FETCH_EMAILS'] } }))).toEqual({ gmail: ['GMAIL_FETCH_EMAILS'] })
  })
  it('reads legacy metadata.connectors as all tools per app', () => {
    expect(effectiveGrants(agent({ metadata: { connectors: 'gmail,github' } }))).toEqual({ gmail: 'all', github: 'all' })
  })
  it('treats an empty connectors string, absent apps, and no agent as unrestricted', () => {
    expect(effectiveGrants(agent({ metadata: { connectors: '' } }))).toBeNull()
    expect(effectiveGrants(agent({}))).toBeNull()
    expect(effectiveGrants(undefined)).toBeNull()
  })
})

describe('checkComposioCall', () => {
  const grants = { gmail: ['GMAIL_FETCH_EMAILS'], github: 'all' as const }
  it('refuses a multi-execute batch with one ungranted slug, naming only that app', () => {
    const reason = checkComposioCall('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'GITHUB_CREATE_AN_ISSUE' }, { tool_slug: 'SLACK_SEND_MESSAGE' }] }, grants)
    expect(reason).toMatch(/Slack/iu)
    expect(reason).not.toMatch(/gmail|github/iu)
  })
  it('allows a batch fully inside the grant', () => {
    expect(checkComposioCall('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'GITHUB_CREATE_AN_ISSUE' }, { tool_slug: 'GMAIL_FETCH_EMAILS' }] }, grants)).toBeUndefined()
  })
  it('fails closed on a malformed batch under a restriction, and allows it unrestricted', () => {
    expect(checkComposioCall('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: 'x' }, grants)).toBeDefined()
    expect(checkComposioCall('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ nope: 1 }] }, grants)).toBeDefined()
    expect(checkComposioCall('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: 'x' }, null)).toBeUndefined()
  })
  it('checks a direct slug against the exact list', () => {
    expect(checkComposioCall('GMAIL_SEND_EMAIL', {}, grants)).toMatch(/Gmail/iu)
    expect(checkComposioCall('GMAIL_FETCH_EMAILS', {}, grants)).toBeUndefined()
    expect(checkComposioCall('GMAIL_SEND_EMAIL', {}, { gmail: 'all' })).toBeUndefined()
  })
  it('allows discovery meta tools and limits connection management to granted apps', () => {
    expect(checkComposioCall('COMPOSIO_SEARCH_TOOLS', { queries: [{ use_case: 'slack' }] }, grants)).toBeUndefined()
    expect(checkComposioCall('COMPOSIO_MANAGE_CONNECTIONS', { toolkits: ['slack'] }, grants)).toMatch(/slack/iu)
    expect(checkComposioCall('COMPOSIO_MANAGE_CONNECTIONS', { toolkits: [{ name: 'gmail' }] }, grants)).toBeUndefined()
  })
})

describe('slugsInCall and isWriteSlug', () => {
  it('lists slugs from batches and direct calls', () => {
    expect(slugsInCall('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'A_B' }] })).toEqual(['A_B'])
    expect(slugsInCall('GMAIL_SEND_EMAIL', {})).toEqual(['GMAIL_SEND_EMAIL'])
    expect(slugsInCall('COMPOSIO_SEARCH_TOOLS', {})).toEqual([])
    expect(slugsInCall('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: 3 })).toBe('malformed')
  })
  it('detects write verbs and explicit slugs', () => {
    const verbs = new Set(['SEND', 'DELETE', 'CREATE'])
    expect(isWriteSlug('GMAIL_SEND_EMAIL', verbs, new Set())).toBe(true)
    expect(isWriteSlug('GOOGLECALENDAR_DELETE_EVENT', verbs, new Set())).toBe(true)
    expect(isWriteSlug('GMAIL_FETCH_EMAILS', verbs, new Set())).toBe(false)
    expect(isWriteSlug('GMAIL_FETCH_EMAILS', verbs, new Set(['GMAIL_FETCH_EMAILS']))).toBe(true)
  })
})

describe('clampGrants', () => {
  it('intersects with the caller', () => {
    expect(clampGrants({ gmail: 'all', slack: 'all' }, { gmail: ['A'] })).toEqual({ gmail: ['A'] })
    expect(clampGrants({ gmail: ['A', 'B'] }, { gmail: ['B', 'C'] })).toEqual({ gmail: ['B'] })
    expect(clampGrants({ gmail: ['A'] }, { gmail: 'all' })).toEqual({ gmail: ['A'] })
  })
  it('an unrestricted caller passes the request through; an unrestricted request takes the caller grant', () => {
    expect(clampGrants({ slack: 'all' }, null)).toEqual({ slack: 'all' })
    expect(clampGrants(null, { gmail: ['A'] })).toEqual({ gmail: ['A'] })
    expect(clampGrants(null, null)).toBeNull()
  })
})

describe('validateAppGrants', () => {
  it('accepts null and valid grants, rejects bad shapes', () => {
    expect(validateAppGrants(null)).toBeUndefined()
    expect(validateAppGrants({ gmail: 'all', github: ['GITHUB_CREATE_AN_ISSUE'] })).toBeUndefined()
    expect(validateAppGrants({ 'Bad App': 'all' })).toMatch(/Bad App/u)
    expect(validateAppGrants({ gmail: 'some' })).toMatch(/gmail/u)
    expect(validateAppGrants({ gmail: ['lower_case'] })).toMatch(/lower_case/u)
    expect(validateAppGrants(['gmail'])).toMatch(/apps/u)
  })
})
