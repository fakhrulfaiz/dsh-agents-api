# File attachments in chat: design

Status: approved and implemented (backend), 2026-11-10; open questions resolved in section 10. DSH evidence paths are relative to `~/code/dsh-pinned/packages/`; Agentry paths are relative to `~/code/dsh-agents-api` (API) or `~/code/agentry-web` (web). Covers backlog items 2 (image endpoint, reused here), 4 (vision route) and part of 5 (non-image uploads).

## 1. Goal and v1 recommendation

The paperclip works in a new chat (no session yet) and an open chat. A user attaches images and files, sends, and the agent can see or open them.

Recommended v1, in one line: **upload first (staged, owner-scoped file id), attach on send.** The send step stores each file in DSH's attachment store, puts a typed block in the logged user message, and copies the bytes to `<workspace>/uploads/<name>`. Images go to the model as images only on vision routes; everywhere else they are verbatim files.

Why this shape:
- Works before a session exists: the id is just a staged upload; `POST /sessions` and `.../events` both accept it.
- Reuses DSH's own model-visible, logged path (typed content blocks), so "model-visible iff logged" holds with no custom event.
- The workspace copy is what the agent's `fs`/shell tools can write to and run against.
- Wire stays OpenAI-compatible: `input_image` / `input_file` parts with `file_id`.

## 2. DSH facts (verified)

- Two kinds of durable reference. `ImageAttachmentRef {attachmentId, mediaType, bytes, width, height, name?}`: normalized raster (png/jpeg/webp/gif) (`attachment/attachment/src/types.ts`, docs `docs/subsystems/attachment.md`). `FileAttachmentRef {attachmentId, name, bytes}`: verbatim bytes, id is the sha256 of exactly those bytes (`attachment/attachment/src/types.ts:39-47`). Ids are opaque, never paths.
- Store API on `ctx.attachments`: `saveImage` (decodes fully, so it is the authority on image validity), `saveFileStream` with backpressure (`attachment/attachment/src/index.ts:231`), `readFileStream` (`:247`), `fileHostPath` (`:265`). Local limits for images: 50 MiB / 64 MP / 65,535 px source, 20 images and 200 MiB per message; files "carry no admission limits" (`docs/subsystems/attachment.md`, `saveFile` JSDoc). So Agentry must enforce file limits itself.
- A user message carries them as content blocks: `ImageBlock {type:'image', attachment}` (`llm/llm/src/types.ts:86`) and `FileBlock {type:'file', attachment}` (`:105`), built with `createUserMessage({content, source})` (Agentry already does this for text: `src/gateway.ts:1673-1676`). The block holds the reference, never base64 or a path, so the Session log is small and replayable.
- Model view, files: request assembly turns every `FileBlock` into text, "name, byte size, read-only saved path ... Read that path with your file tools" (`llm/llm/src/content.ts:151-157`); path from `fileReadPath` via `attachments.fileHostPath` then `fs.processPathFromHostPath` (`llm/llm/src/index.ts:1047-1058`). The path is under `DSH_HOME/attachments`, outside the workspace, read-only.
- Model view, images: sent natively only when the route has `inputModalities` containing `image` (`llm/llm-deepseek/src/images.ts:46-47`, else `UNSUPPORTED_CONTENT`). Otherwise the text-only placeholder `[image omitted because this model accepts text only; attachment sha256:xxxxxxxx]` replaces the block (`llm/llm/src/content.ts:76-79`); it names no path, so a withheld image is not inspectable from that text alone. `offloaded` images get a placeholder with a read-only path (`llm/llm/src/types.ts:86-95`).
- Host prompt path (the DSH web app) refuses an image prompt when `inputModalities` is defined and lacks `image`, with `MODEL_DOES_NOT_SUPPORT_IMAGES`; an undefined list is allowed (`api/session-controller/src/commands.ts:313-325`). Agentry builds its own message, so it must make this decision itself (section 5).
- DSH's browser path is receipts (`ctx.fileUploads.uploadStream`/`uploadImageStream`, `client/file-upload/src/index.ts`) bound to an `Agent`, hence to an existing Session. It cannot serve a new chat, which is why Agentry stages its own uploads.
- Agentry session workspace: `<workspaces>/<owner>/<sessionId>` created by `defaultWorkspace` (`src/gateway.ts:1226-1230`); `self_hosted`/`local` environments may point elsewhere (`:1194-1215`). The live cwd is `sessionRegistry.get(id).workspace` or `history.workspace(id)` (`src/gateway.ts:427`). `EnvironmentProvider.writeFile(record, path, content)` already exists for local and Codebox (`src/environment/provider.ts:66`, `local.ts:131`, `codebox.ts:407`); `src/artifacts.ts:166-175` shows the resolve-and-contain path check to copy.
- `src/items.ts:96-110` folds `user/message` into one `input_text` item using `textFromContent`, which ignores non-text blocks (`src/input.ts` `textFromContent`). Replay and live both use this fold, so changing it fixes both.

## 3. Wire format

OpenAI-compatible parts (Responses/Agents style): `{type:'input_text', text}`, `{type:'input_image', image_url | file_id, detail?}`, `{type:'input_file', file_id | file_data | file_url, filename?}`; the file object is `{id, object:'file', bytes, created_at, filename, purpose}` from `POST /v1/files` (multipart `file` + `purpose`). Not re-verified against live OpenAI docs in this pass; confirm before the OpenAPI edit.

Agentry v1 accepts only `file_id` for both part types. `image_url`, `file_data`, `file_url` get 400 `unsupported_content_part` (no server-side fetching, no SSRF, no base64 in JSON bodies). `OAIInputMessage.content` (`src/types.ts:433-436`) widens to the three part types; `userTextFromInput` (`src/input.ts:14`) keeps joining `input_text` only, and a new `fileIdsFromInput` collects ids in order. A message with files and no text is valid.

Endpoints (route table, OpenAPI, and the drift tests move together):
- `POST /v1/agents/files`: multipart, one `file` part, optional `purpose` (default `user_data`). 201 file object plus `media_type`, `status:'staged'`. Errors: 400 `invalid_file`, 413 `file_too_large`, 415 `unsupported_media_type`, 429 `staging_quota_exceeded`.
- `GET /v1/agents/files/{id}/content`: bytes. Owner-scoped (other owner: 404).
- `DELETE /v1/agents/files/{id}`: staged only (removes a chip). Attached: 409 `file_attached`.
- `files` joins the reserved agent ids so `/agents/files` never matches `/agents/:agent_id` (route comment `src/gateway.ts:5`; web `RESERVED_AGENT_IDS`).

Item parts (live SSE and replay): user message items gain `{type:'input_image'|'input_file', file_id, filename, bytes, media_type, width?, height?}` beside `input_text`. `file_id`/`filename`/`bytes`/`media_type`/size are Agentry extension fields on the OpenAI part types.

## 4. Storage, records, cleanup

- Staging directory, new config `uploads.dir` (required when uploads are on; loud failure if unwritable). Layout `<dir>/<owner-segment>/<file_id>`, bytes only, no user-supplied name on disk. It must be outside `workspaces` so a sandboxed agent cannot read other users' staged files (decision 5).
- After attach, the durable copy is DSH's attachment store (`DSH_HOME/attachments`, never auto-deleted; retention-neutral, content-addressed). The staging file is deleted once the message is queued. The workspace copy is the agent's working file and may change; it is never served back to the UI.
- Postgres migration `0003-files.sql` (forward-only, decision 7), one table `files`: `id text pk` (`file_<random>`), `owner text not null`, `name text`, `media_type text`, `bytes bigint`, `sha256 text`, `status text` (`staged | attached`), `session_id text null`, `attachment_id text null` (DSH id after attach), `workspace_path text null`, `created_at`, `attached_at`. Indexes: `(owner, status, created_at)` for the sweep and quota, `(owner, session_id, attachment_id)` for replay lookups. No bytes in Postgres; the Session log stays the history source.
- Cleanup: a sweeper registered with `ctx.effect()` (disposer clears the timer) runs at startup and every `uploads.sweepIntervalMinutes`; it deletes `staged` rows and files older than `uploads.stagedTtlMinutes` (default 1440). Startup also removes staging files with no row (crashed upload) and rows with no file. Attached rows are kept so history keeps working; deleting a session deletes its rows, not DSH objects.
- Quotas as config: `uploads.maxFileBytes`, `maxFilesPerMessage`, `maxMessageBytes`, `maxStagedBytesPerOwner`, `allowedMediaTypes`. Defaults chosen at plan time; none hard-coded in the plugin (DSH rule on tunables).

## 5. Send flow (new chat and open chat)

Both `POST /sessions` (`input` array) and `POST /sessions/{id}/events` (`agent.session.input.message`) call one `AttachmentIngest.attach(owner, sessionId, cwd, fileIds)`:
1. Validate before anything is created: every id exists, is the caller's, is `staged`, not repeated, within per-message limits. Else 400/404 with no side effect. For a new chat this runs before the session is provisioned.
2. Claim rows `staged -> attached` in one transaction, setting `session_id`.
3. Vision decision per image: `ctx.llm.resolveModelInfo(provider, model).inputModalities` includes `image`, or is `undefined` (same permissive rule as `commands.ts:319`). Use the model after any `model` change on the same request. Vision route and a raster png/jpeg/webp/gif: `saveImage` then `ImageBlock`. Anything else, including images on non-vision routes: `saveFileStream` from the staging file then `FileBlock`. A later switch to a text-only route degrades gracefully to the placeholder (`content.ts:76`), and the workspace copy remains.
4. Copy each file to `<cwd>/uploads/<safe name>` through the environment provider (`writeFile`), creating `uploads/` if absent; collisions get ` (2)` suffixes; record `workspace_path`.
5. Build the message: `[text block, ...image/file blocks, note block]`, `source:{kind:'user'}`, then `agent.followup`/`steer` as `triggerTurn` does today (`src/gateway.ts:1673-1681`). The note is one text block: `Attached files copied to the workspace: uploads/a.png (image/png, 12 KB); ...`. It is in the Session log, so it is model-visible and logged. It is the only inspectable path for a withheld image, and it names a writable location for files (the `FileBlock` handle names a read-only one).
6. Delete staging files. A failure at steps 2-5 returns an error and rolls rows back to `staged` where the message was not queued; once queued, failures to delete staging are logged and left to the sweeper.

Folding the note: `itemsFromEvent` treats a text block that starts with the fixed prefix `Attached files copied to the workspace:` as agent-facing, not user text, so the user bubble shows the typed text plus parts. Prefix is a constant shared by writer and fold, with a test pinning both.

Replay: `itemsFromEvent` emits parts from `image`/`file` blocks. `file_id` comes from a batched lookup `(owner, session_id, attachment_id)`; blocks without a row (not uploaded through this route) render with name and size and no content link. Subagent and schedule messages are unchanged.

## 6. Content endpoint and security

- Owner check on every route: `store.files.get(id, owner)`; another owner's id is 404, never 403.
- Serve `staged` from the staging file and `attached` from the DSH store (`readFileStream`, or `readImage` for the normalized image). Stream, never buffer. Set `Content-Length`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Content-Disposition: inline` for sniffed raster images and `attachment; filename*=UTF-8''...` for everything else, `Cache-Control: private, max-age=3600` (ids are immutable). SVG, HTML and unknown types are served as `application/octet-stream` attachments.
- Media type is decided by the server: magic-byte sniff for rasters (`fs/tool-fs/src/read-image.ts:54-58` has the signatures; `saveImage` stays the validity authority), extension allow-list for the rest. The client's `Content-Type` and extension are advisory, mismatch rejects with 415.
- Names: take the last path segment, drop NUL and control characters and path separators, reject empty, `.`/`..`, trim leading dots, cap at 120 bytes, normalize NFC, avoid Windows reserved names. The name is only ever a leaf; the staging id is random. The workspace write uses exclusive create (`wx`), never follows a pre-existing symlink, and verifies the resolved `uploads/` directory stays inside the workspace root (pattern `src/artifacts.ts:166-175`); the agent can replace `uploads/` with a symlink, so this check is not optional.
- Limits are enforced while streaming: early 413 from `Content-Length`, a counting stream that aborts and unlinks at `maxFileBytes`, and the staged-bytes quota checked before accepting. Multipart parsing uses a maintained streaming parser (busboy) with `fileSize`, `files:1`, `parts` limits; DSH policy prefers maintained dependencies over hand-rolled parsing. The existing `readBody` buffers whole bodies (`src/http.ts:20-31`) and is not used for uploads.
- Not served: files of a deleted session, other owners' ids, paths. Responses never include server paths.

## 7. BFF (agentry-web)

- The catch-all proxy buffers request bodies with `req.arrayBuffer()` and forces `accept: application/json` (`app/api/agentry/[...path]/route.ts`), so it cannot carry uploads or downloads of size. Add two static route handlers (they win over `[...path]`): `app/api/agentry/files/route.ts` (POST) and `app/api/agentry/files/[id]/content/route.ts` (GET, DELETE).
- Upload: same auth, origin and CSRF checks as the proxy (`src/server/csrf.ts`, `require-auth.ts`); require `Content-Length` (411 otherwise) and reject over `AGENTRY_UPLOAD_MAX_BYTES` before reading; forward `req.body` as a stream (`duplex:'half'`) with the same multipart `content-type`, through a counting `TransformStream` that cancels on overrun. Relay status and JSON body. Verify in this Next 16.4 app that no `proxy.ts` caps client body size for `/api`.
- Download: `GET` forwards the bearer, returns the upstream stream with `content-type`, `content-disposition`, `content-length`, `nosniff`, `csp`, and keeps `private, max-age` instead of `relay()`'s `no-store` (`src/server/upstream.ts:12-17` takes `extraHeaders`; extend it to pass these through). `<img src>` works because auth is the session cookie.
- `src/server/allowlist.ts` adds `files` to `RESERVED_AGENT_IDS` and rules for the three routes (GET/DELETE on `files/{id}/content` path shape only); the id pattern already limits to `[A-Za-z0-9_-]`. Update `tests` for the allowlist.
- `src/api/client.ts` gets `uploadFile(file, {onProgress, signal})` (XHR, since `fetch` has no upload progress), `deleteFile`, and `sendMessage`/`createSession` accept `files: FileRef[]`, building `input_text` + `input_image`/`input_file` parts (`src/api/client.ts:159,173`; types `src/api/types.ts:279`).

## 8. Frontend UX

- Paperclip enabled (`Composer.tsx:196`, remove `ATTACH_HINT`); opens a hidden multi-file input. Drag and drop onto the composer shows a drop overlay ("Drop to attach"); paste of clipboard files (screenshots) attaches too and does not eat pasted text.
- Chips in the existing `ChatComposerDrawer` (`Composer.tsx:186-192`, replacing the `string[]` stub at `:132`): thumbnail for images (object URL, revoked on remove/send), name, size, determinate progress while uploading, error state with retry and remove, remove button on every chip. Uploads start immediately on selection and run in parallel (max 3); remove during upload aborts and deletes.
- Send is disabled while any chip is uploading or errored; empty text with at least one ready file is allowed. On failure the chips stay (the composer already restores text, `Composer.tsx:106-111`). On success the chips clear and the user bubble shows the sent parts.
- Client pre-checks size and type from the BFF-provided limits for fast feedback; the backend stays authoritative, and its 413/415/429 map to specific chip messages in the product's sentence-case copy.
- New chat: same component; files upload to staging, `createSession` carries the ids. Leaving the page leaves staged files to the TTL sweep.
- Message display (`src/ui/chat/Message.tsx`): image parts render as thumbnails (use `width/height` to reserve space, click opens a larger view); file parts render as cards with icon, name, size and a download link to `/api/agentry/files/{id}/content`; a 404 shows an "unavailable" card. The reducer (`src/chat/reducer.ts`) appends parts from the item, so live and reload look the same; the optimistic user bubble uses the local chips until the item event replaces it.
- Accessibility: input has a label, chips are a list, remove buttons have names, progress is announced, drop zone has a keyboard alternative (the button).

## 9. Task breakdown

Backend (API repo). B1 first; B2-B5 in dependency order; frontend F1 can start once B1 (OpenAPI) lands.

| # | Task | Files | Tests | Model |
|---|---|---|---|---|
| B1 | OpenAPI + wire types: file object, three routes, widened input parts, item parts, error codes | `openapi/agentry.yaml`, `src/types.ts`, `src/input.ts` | `tests/openapi-drift.spec.ts`, `openapi-contract.spec.ts`, `tests/input.spec.ts` (parts, rejection of `image_url`/`file_data`) | Sonnet |
| B2 | Migration + store: `files` table, `FileStore` with owner-scoped get/claim/release/sweep | `src/store/migrations/0003-files.sql`, `src/store/store.ts`, `postgres.ts` | store tests incl. second-owner 404, claim race | Sonnet |
| B3 | Upload + sweeper: busboy stream, limits, sniff, name sanitizer, quota, config fields, effect-registered sweeper | `src/files/upload.ts`, `src/files/names.ts`, `src/files/sweeper.ts`, `src/index.ts` (config + validation) | oversize (header and streamed), wrong magic, traversal names, partial-file unlink, TTL sweep, config fails loud | Opus (security-critical) |
| B4 | Content + delete routes, headers, owner checks | `src/files/content.ts`, `src/gateway.ts` route table and reserved id | other owner 404, nosniff/CSP/disposition per type, SVG as attachment, 409 on attached delete | Sonnet |
| B5 | `AttachmentIngest`: validate, claim, vision decision, `saveImage`/`saveFileStream`, workspace copy, note block, rollback; wire into create and events paths | `src/files/ingest.ts`, `src/gateway.ts` (`:510`, `:1227`), `src/environment/*` use | vision vs non-vision, symlinked `uploads/`, name collision, rollback on failure, new chat and open chat, steer while running, file-only message | Opus |
| B6 | Items: parts from blocks, hide note, replay lookup | `src/items.ts`, `src/history/projector.ts`, `session-history.ts` | fold unit tests, replay after restart, unknown attachment fallback, subagent/schedule unchanged | Sonnet |
| B7 | Live check + docs | `CHANGELOG.md`, `docs/changes/2026-11-10-attachments.md`, `docs/README.md`, `AGENTS.md` backlog 2/5 status | smoke script against a real DeepSeek key: image on vision route, text file on flash route, agent reads and edits `uploads/` | Sonnet |

Frontend (web repo).

| # | Task | Files | Tests | Model |
|---|---|---|---|---|
| F1 | BFF routes + allowlist + upstream header passthrough, stream limits | `app/api/agentry/files/route.ts`, `files/[id]/content/route.ts`, `src/server/allowlist.ts`, `upstream.ts` | allowlist cases, 411/413, CSRF, abort cancels upstream, download headers | Opus |
| F2 | API client + types: `uploadFile` (XHR progress), `deleteFile`, send with file parts | `src/api/client.ts`, `src/api/types.ts` | client unit tests with mock | Sonnet |
| F3 | Attachment state hook: queue, concurrency, retry, remove, object-URL lifecycle | `src/chat/use-attachments.ts` | vitest: states, abort, revoke | Sonnet |
| F4 | Composer UI: paperclip, drop overlay, paste, chips, errors, send gating; wire into `NewChat.tsx` and `use-conversation.ts` | `src/ui/chat/Composer.tsx`, `NewChat.tsx`, `src/chat/use-conversation.ts`, `src/chat/reducer.ts` | component tests; Playwright: attach, drag, paste, error, remove, send in new and open chat | Sonnet |
| F5 | Message rendering: thumbnails, file cards, unavailable state, viewer | `src/ui/chat/Message.tsx`, new `AttachmentParts.tsx` | render tests, replay after reload; mock server gains `/files` handlers in `mock/` | Sonnet |
| F6 | Docs + changelog; flip paperclip hint copy | `CHANGELOG.md`, `AGENTS.md` | none | Sonnet |

## 10. Resolved (2026-11-10)

1. The agent relies on the `uploads/` copy in the workspace. Whether `DSH_HOME/attachments` is readable under the sandbox is checked in the live check (B7) and recorded in `docs/changes/2026-11-10-attachments.md`.
2. Keep both the DSH `FileBlock`/`ImageBlock` and the workspace copy plus the logged note.
3. Defaults: 25 MB (25 MiB) per file, 10 files per message, as validated config fields (`maxMessageBytes` and `maxStagedBytesPerOwner` default to 50 MiB and 500 MiB).
4. Tool-result images (and later agent deliverables) are served through the same owner-checked content route if cheap: the route is generic over file sources (`FileSource`), v1 ships the staged and attached sources only.
5. The workspace copy is written only into `<workspace>/uploads/`, never overwrites an existing file (`name-1.ext`, `name-2.ext`), and rejects path traversal (including a symlinked `uploads/`).

Added decision: staging sits behind a small `FileStore` interface (`put`, `get`, `delete`, `stream`) with a filesystem implementation only. An S3/SeaweedFS implementation comes later behind the same interface and is not part of this work.
