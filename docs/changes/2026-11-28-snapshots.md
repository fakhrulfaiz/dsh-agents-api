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
- Download and upload of files-only snapshots: see below. Not built: scheduled snapshots, renaming.

Tests: `tests/gateway.spec.ts` ("environment snapshots through the gateway") against a stand-in service.

## Download and upload (files-only), added 2026-11-28

| Route | Does |
|---|---|
| `GET /agents/environments/snapshots/{id}/content` | streams the tar.gz (`Content-Type: application/gzip`, the service's `Content-Length` and `Content-Disposition`); 400 not files-only, 409 not ready, 404 unknown or another owner's |
| `POST /agents/environments/snapshots/import?name=` | streams the request body to the service's `POST /v1/snapshots/import`; 201 with the snapshot (`environment_id: null`); 400 bad or unsafe archive, 413 too large, 429 over the snapshot limit |

Both pass the file through (`Readable.fromWeb` / `Readable.toWeb`, no buffering) and go through the provider's `downloadSnapshot` / `importSnapshot`, which call the service with the owner header. An aborted client request aborts the upstream call. Uploaded snapshots have no environment; any owner's list shows them with `environment_id: null`.

Tests: `tests/gateway.spec.ts` (download headers and bytes, refusals, owner scoping, upload bytes and name, pass-through errors).
