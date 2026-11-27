# Environment create in the background (2026-11-27)

Problem: `POST /agents/environments` waited for the provider's whole setup (image pull, packages, setup commands). A slow
GPU-box create hit the 180 s client timeout and the environment was recorded as failed while its sandbox kept running; a reload
or another device could not see the environment until setup ended.

## Behaviour

- `POST /v1/agents/environments` (the create route only) takes `{ background: true }` through `provisionEnvironment`. All request
  validation (400s) still happens first and synchronously. Only the `sandbox` provider goes to the background; `local` is instant.
- The record is stored as `pending` with the display name, and the route answers 201. `environmentJson` shows `status: pending`
  and `sandbox: { state: 'provisioning' }` while no sandbox id is stored yet.
- The provider's `create` then runs; the record is updated to `connected` (handle, workspace) or `failed` (`error`).
- Timeout: when `create` fails with a timeout-like error and the provider has `adopt` (Agentry Sandbox: lists the owner's
  sandboxes and takes the newest with the same name created since the call began), the gateway adopts it. A still provisioning
  sandbox is polled (5 s, up to 15 minutes; `gateway.environmentAdoption` in tests); no sandbox means the failure stands.
- Delete during setup: the record is removed at once; the background task destroys whatever it created when it ends.
- Interruption: a `pending` sandbox record with no sandbox id that no running setup owns (API restart) is marked `failed`
  with "Setup was interrupted." when it is read (list or get).
- Unchanged: the in-chat `sandbox_create` provision and session-create inline environments wait for a ready environment.

## Notes

- A failed record with no sandbox id is no longer re-asked from the provider on `GET` (that replaced the real error).
- Adoption matches by sandbox name (the display name, else the environment id), so two same-named creates by one owner
  within seconds of each other could adopt each other's sandbox; acceptable for the timeout path only.
