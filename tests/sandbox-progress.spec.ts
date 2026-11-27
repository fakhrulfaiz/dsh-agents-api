import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createAgentrySandboxProvider } from '../src/sandbox/agentry-sandbox-provider.ts'
import type { EnvironmentRecord } from '../src/environment-types.ts'

let server: http.Server | undefined
afterEach(async () => {
  server?.closeAllConnections()
  await new Promise<void>(r => (server ? server.close(() => r()) : r()))
  server = undefined
})

/** A sandbox service that answers every sandbox read with `body`. */
async function serve(body: Record<string, unknown>): Promise<string> {
  server = http.createServer((_req, res) => void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body)))
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}
const sandbox = { id: 'sbx_1', object: 'sandbox', name: 'x', backend: 'docker', place: 'docker', gpus: 0, template_id: null, image: 'img', workspace_path: '/workspace', error: null, created_at: 1, started_at: null, last_used_at: null }
const rec = { id: 'env_1', object: 'environment', status: 'pending', provider: 'sandbox', provider_metadata: { sandbox_id: 'sbx_1', workspace_directory: '/workspace', owner: 'owner-a' }, created_at: 1 } as unknown as EnvironmentRecord
const provider = (url: string) => createAgentrySandboxProvider({ url, key: 'k', workspacesRoot: '/tmp/agentry-progress-unused' })

describe('sandbox setup progress', () => {
  it('passes the service progress through while provisioning', async () => {
    const progress = { stage: 'running_setup', step: 2, steps: 3, detail: 'npm install', updated_at: 1764230000 }
    const s = await provider(await serve({ ...sandbox, state: 'provisioning', progress })).describe(rec)
    expect(s).toMatchObject({ state: 'provisioning', progress })
  })

  it('leaves progress out once the sandbox is running, even if the service still sends it', async () => {
    const s = await provider(await serve({ ...sandbox, state: 'running', progress: { stage: 'finishing', updated_at: 1 } })).describe(rec)
    expect(s.state).toBe('running')
    expect(s).not.toHaveProperty('progress')
  })

  it('has no progress from a service that does not send it', async () => {
    const s = await provider(await serve({ ...sandbox, state: 'provisioning' })).describe(rec)
    expect(s).not.toHaveProperty('progress')
  })
})
