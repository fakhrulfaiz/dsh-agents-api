# File attachments (backend)

Date: 2026-11-10. Spec: [attachments design](../superpowers/specs/2026-11-10-attachments-design.md). Wire detail: [http-api](../http-api.md#file-attachments).

## What changed

- `POST /v1/agents/files` stages one multipart file per request, `GET /v1/agents/files/{file_id}/content` serves it, `DELETE /v1/agents/files/{file_id}` removes a staged file. All are owner-scoped; another owner's id is `404`.
- `POST /v1/agents/sessions` (`input`) and `POST /v1/agents/sessions/{id}/events` accept `input_image` and `input_file` parts with `file_id`. Validation (ids, owner, limits, duplicates) runs before a new session is created or a model change is applied.
- On send each file goes to the DSH attachment store (`ImageBlock` for a raster on a route that takes images, `FileBlock` otherwise) and is copied to `<workspace>/uploads/<name>`. The logged user message is `[text, ...image/file blocks, note]`, so what the model sees is in the Session log. The note starts with `Attached files copied to the workspace:` and is hidden from item parts.
- User message items gain `input_image` / `input_file` parts with `file_id`, `filename`, `bytes`, `media_type`, `width`, `height`. Migration `0003-files.sql` adds the `files` table (no bytes in Postgres).
- A sweeper (started with the store, stopped by its effect disposer) removes staged files older than `uploads.stagedTtlMinutes` and staging bytes whose row is missing or no longer staged.

## Decisions

- Staging sits behind `FileStore` (`put`, `get`, `stream`, `delete`, plus `verify` and `list` for startup and the sweeper). Only a filesystem implementation exists. An S3 or SeaweedFS implementation comes later behind the same interface; nothing else changes.
- Content is served through `FileSource`s tried in order. v1 has one source (staged and attached uploads). Tool-result images and agent deliverables can be added as sources without a new route.
- The workspace copy is written with exclusive create and `O_NOFOLLOW`, never overwrites, rejects a symlinked or non-directory `uploads/`, and checks where the bytes landed. It uses the filesystem directly, not `EnvironmentProvider.writeFile`, which overwrites.
- The agent relies on the `uploads/` copy. The `FileBlock` handle points at `DSH_HOME/attachments` (read-only); the live check did not need it.
- An image DSH cannot decode or admit is sent as a file instead of failing the message.
- Uploads are off until `uploads.dir` is set (`501 uploads_disabled`). `uploads.dir` must not lie inside or contain `workspaces`, so a sandboxed agent cannot read other users' staged files.
- Quota: `Content-Length` is checked with a 64 KiB allowance for multipart framing; the exact staged total is checked again after the file is stored.

## Limits and known gaps

- Defaults: 25 MiB per file, 10 files and 50 MiB per message, 500 MiB staged per owner, TTL 24 h. All are config fields.
- A deleted session deletes its `files` rows, so its content links answer `404`; the DSH objects stay (content-addressed).
- `file_id` resolution for two uploads of identical bytes in one session returns the first row for both.
- Not implemented: serving tool-result images, agent deliverables, `GET /agents/files` listing.

## Live check (2026-11-10)

A separate instance (profile with `uploads.dir`, port 3092, own database and DSH home) was driven with one text file and one PNG: upload, create session with both, wait for idle, read items, fetch content. Result: both files appeared as `input_file`/`input_image` parts with `file_id`; the content route answered `200 image/png`, `inline`, `nosniff`; the workspace held `uploads/notes.txt` and `uploads/red.png`; the staging directory was empty after the send; the unauthenticated fetch was `401`. The route `deepseek-v4-flash` declares no image input, so the PNG was sent as a file, and the agent read `uploads/notes.txt` with its file tool and answered with the secret word. It could not read the PNG with `read_image` (route limitation) and decoded it in Python. The live instance on :3080 was not touched.
