# Sandbox snapshots (2026-11-28)

The Agentry Sandbox service saves snapshots of a sandbox (`workspace` files, whole `disk`, or `memory`). The API exposes them per environment, owner-scoped; the service is called with the caller's owner, so another owner's snapshot id answers 404.

| Route | Answer |
|---|---|
| `POST /agents/environments/{id}/snapshots` `{name?, level?, stop_first?}` | 202, the snapshot in `saving` |
| `GET /agents/environments/{id}/snapshots` | `{object:'list', data}`, newest first, this environment's only |
| `GET /agents/environments/snapshots` | all of the owner's, with `environment_id: null` for deleted environments |
| `GET /agents/environments/snapshots/{id}` | one (poll until `ready` or `failed`) |
| `DELETE /agents/environments/snapshots/{id}` | `{id, object:'snapshot.deleted', deleted:true}` |
| `POST /agents/environments/{id}/restore` `{snapshot_id}` | the environment |
| `POST /agents/environments` `{snapshot_id}` | creates from a snapshot |
| `DELETE /agents/environments/{id}?delete_snapshots=true` | deletes the environment's snapshots first |

Wire shape: the service's snapshot with `environment_id` in place of `sandbox_id` (no handles, no owner). `GET /agents/environments/providers` adds `snapshot_levels` to the sandbox row and to each place.

Decisions:
- Deleting an environment keeps its snapshots (they can still start a new environment); `delete_snapshots=true` removes them. The service sweeps old snapshots after `AGENTRY_SANDBOX_SNAPSHOT_DAYS` (default 30).
- Create from a snapshot checks the snapshot first: unknown or foreign 404, `saving` or `failed` 400 `snapshot_not_ready`. A `disk` or `memory` snapshot defaults the place to the one that took it.
- Service refusals (400 level the place lacks, 409 `snapshot_not_ready`, 429 quota) pass through unchanged; `snapshots_off` reads "Snapshots are not set up on this service."
- Restore closes the environment's terminals and browser (a rebuild drops them). It is not refused during a chat turn, like reset.
- The name of a deleted environment is not kept (the service does not give it); clients show the snapshot's own name.
- Not built: download/upload of snapshots, scheduled snapshots, renaming.

Tests: `tests/gateway.spec.ts` ("environment snapshots through the gateway") against a stand-in service.
