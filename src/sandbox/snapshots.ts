/**
 * Snapshots as the Agentry API shows them: the sandbox service's wire shape with
 * the API's environment id in place of the service's sandbox id.
 */
import type { SandboxApiError, WireSnapshot } from '@agentry/sandbox/client'

/** A snapshot of an environment; `environment_id` is `null` once its environment was deleted (the snapshot outlives it). */
export interface EnvironmentSnapshot extends Omit<WireSnapshot, 'sandbox_id'> {
  environment_id: string | null
}

export function snapshotJson(snap: WireSnapshot, environmentId: string | null): EnvironmentSnapshot {
  const { sandbox_id: _sandbox, ...rest } = snap
  return { ...rest, environment_id: environmentId }
}

export const newestFirst = (snaps: readonly WireSnapshot[]): WireSnapshot[] => [...snaps].sort((a, b) => b.created_at - a.created_at)

/** The service's own wording is plain; only the folder-not-set case names a server setting, which a person cannot act on. */
export function snapshotMessage(e: SandboxApiError): string {
  return e.code === 'snapshots_off' ? 'Snapshots are not set up on this service.' : e.message
}
