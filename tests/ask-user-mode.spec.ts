/**
 * The approval bridge claims only untimed `ask_user_question` waits, so the
 * pinned tool must keep defaulting to its blocking mode. `mode: timed` makes
 * DSH wait for a Client countdown that the Agents API never drives.
 */

import { describe, expect, it } from 'vitest'
import { Config } from '@deepseek-ai/dsh-tool-ask-user'

describe('ask_user_question defaults', () => {
  it('uses the blocking tool unless a row opts into timed mode', () => {
    expect(Config({}).mode).toBe('legacy')
  })
})
