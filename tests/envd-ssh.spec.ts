import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { startTestService } from '@agentry/sandbox/testing'
import { EnvdSshConnection } from '../src/sandbox/remote/envd-ssh.ts'

describe('EnvdSshConnection errors', () => {
  it('a sandbox that no longer exists says so (review I5), not "no DeepSeek Harness runtime"', async () => {
    const svc = await startTestService()
    try {
      const conn = new EnvdSshConnection(new Context(), { url: svc.url, key: svc.key, owner: 'o', sandboxId: 'sbx_deleted', workspace: '/w' })
      const failure = conn.request('heartbeat', {}, z.null())
      await expect(failure).rejects.toThrow(/no longer exists/)
      await expect(failure).rejects.not.toThrow(/runtime/)
      await conn.dispose()
    } finally {
      await svc.close()
    }
  })
})
