import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSandboxApi } from '@agentry/sandbox/client'
import { startTestService, type TestService } from '@agentry/sandbox/testing'

let svc: TestService
beforeEach(async () => { svc = await startTestService() })
afterEach(async () => svc.close())

describe('@agentry/sandbox link', () => {
  it('creates and lists a sandbox through the linked client', async () => {
    const api = createSandboxApi({ url: svc.url, key: svc.key, owner: 'owner-1' })
    const s = await api.create({ name: 'linked' })
    expect((await api.list()).map((x) => x.id)).toEqual([s.id])
  })
})
