import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { applyHostToolsRestrict } from '../src/host-tools.ts'
import {
  AGENTRY_SCHEDULE_GUIDANCE,
  AGENTRY_SCHEDULE_SECTION,
  mountScheduleGuidance,
} from '../src/mount-schedule-guidance.ts'

interface Section {
  name: string
  order: number
  text: (context: { scope?: unknown }) => string
}

/** An agent scope whose tool view honors `restrict` masks, as the Host registry does. */
function agentScope(tools: string[], options: { systemPrompt?: boolean } = {}): { agentCtx: Context; sections: Section[] } {
  const sections: Section[] = []
  const visible = new Set(tools)
  const agentCtx = {
    get: (name: string) => name === 'systemPrompt' && options.systemPrompt !== false ? {} : undefined,
    systemPrompt: {
      section: (section: Section) => {
        sections.push(section)
      },
      getSectionOrder: (name: string) => name === 'TOOL_SCHEDULE' ? 2500 : 0,
    },
    tools: {
      get: (name: string) => visible.has(name) ? { name } : undefined,
      restrict: (filter: { allow?: string[]; deny?: string[] }) => {
        for (const name of filter.deny ?? []) visible.delete(name)
        return () => undefined
      },
    },
  } as unknown as Context
  return { agentCtx, sections }
}

describe('mountScheduleGuidance', () => {
  it('registers a section just after tool:schedule that shows the guidance while schedule_create is mounted', () => {
    const { agentCtx, sections } = agentScope(['schedule_create', 'schedule_list'])
    mountScheduleGuidance(agentCtx)
    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({ name: AGENTRY_SCHEDULE_SECTION, order: 2501 })
    const text = sections[0]!.text({})
    expect(text).toBe(AGENTRY_SCHEDULE_GUIDANCE)
    expect(text).toContain('`this_session`')
    expect(text).toContain('time zone')
  })

  it('shows nothing when the schedule tools are not mounted', () => {
    const { agentCtx, sections } = agentScope(['web_fetch'])
    mountScheduleGuidance(agentCtx)
    expect(sections[0]!.text({})).toBe('')
  })

  it('shows nothing after host_tools.deny hides schedule_create', () => {
    const { agentCtx, sections } = agentScope(['schedule_create', 'schedule_list'])
    applyHostToolsRestrict(agentCtx, { deny: ['schedule_create'] })
    mountScheduleGuidance(agentCtx)
    expect(sections[0]!.text({})).toBe('')
  })

  it('registers nothing on a Host without a system prompt', () => {
    const { agentCtx, sections } = agentScope(['schedule_create'], { systemPrompt: false })
    mountScheduleGuidance(agentCtx)
    expect(sections).toEqual([])
  })
})
