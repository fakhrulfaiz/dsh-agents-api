import { describe, expect, it } from 'vitest'
import { errorMessage, listQuery, matchRoute, normalizePath, paginate, routeParam } from '../src/http.ts'

describe('normalizePath', () => {
  it('strips a trailing slash except on root', () => {
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('/v1/agents/')).toBe('/v1/agents')
    expect(normalizePath('/v1/agents')).toBe('/v1/agents')
  })
})

describe('matchRoute', () => {
  it('captures parameters and rejects mismatches', () => {
    expect(matchRoute('/agents/:agent_id', '/agents/agent_1')).toEqual({ agent_id: 'agent_1' })
    expect(matchRoute('/agents/:agent_id', '/agents/sessions')).toEqual({ agent_id: 'sessions' })
    expect(matchRoute('/agents/sessions', '/agents/sessions')).toEqual({})
    expect(matchRoute('/agents/:id', '/agents/a/b')).toBeNull()
    expect(matchRoute('/agents/sessions', '/agents/other')).toBeNull()
    expect(matchRoute('/agents/:id/turns/:turn_id', '/agents/s1/turns/t1')).toEqual({
      id: 's1',
      turn_id: 't1',
    })
  })
})

describe('listQuery', () => {
  it('clamps limit and copies after/order', () => {
    const url = new URL('http://x/v1/agents?limit=500&after=a1&order=asc')
    expect(listQuery(url)).toEqual({ limit: 100, after: 'a1', order: 'asc' })
    expect(listQuery(new URL('http://x/'))).toEqual({ limit: 20 })
    expect(listQuery(new URL('http://x/?limit=nope'))).toEqual({ limit: 20 })
    expect(listQuery(new URL('http://x/?order=sideways'))).toEqual({ limit: 20 })
    expect(listQuery(new URL('http://x/?limit=0')).limit).toBe(1)
    expect(listQuery(new URL('http://x/?limit=-4')).limit).toBe(1)
    expect(matchRoute('/agents/:agent_id', '/agents/a%2Fb')).toEqual({ agent_id: 'a/b' })
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('raw')).toBe('raw')
    expect(routeParam({ agent_id: 'a1' }, 'agent_id')).toBe('a1')
    expect(() => routeParam({}, 'agent_id')).toThrow('Missing route parameter "agent_id"')
  })
})

describe('paginate', () => {
  const items = [{ id: 'a', created_at: 1 }, { id: 'b', created_at: 2 }, { id: 'c', created_at: 3 }]

  it('pages by created_at and after cursor', () => {
    const page = paginate(items, { limit: 2, order: 'desc' }, item => item.created_at)
    expect(page.data.map(item => item.id)).toEqual(['c', 'b'])
    expect(page.has_more).toBe(true)
    const next = paginate(items, { limit: 2, order: 'desc', after: 'b' }, item => item.created_at)
    expect(next.data.map(item => item.id)).toEqual(['a'])
    expect(next.has_more).toBe(false)
    expect(paginate(items, { limit: 10, order: 'asc' }, item => item.created_at).data.map(item => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('reverses natural order when createdAt is omitted', () => {
    const desc = paginate(items, { limit: 10, order: 'desc' })
    expect(desc.data.map(item => item.id)).toEqual(['c', 'b', 'a'])
    const asc = paginate(items, { limit: 10, order: 'asc' })
    expect(asc.data.map(item => item.id)).toEqual(['a', 'b', 'c'])
    const missed = paginate(items, { limit: 10, after: 'missing', order: 'asc' })
    expect(missed.data).toHaveLength(3)
  })
})
