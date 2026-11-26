# Images from tool results (2026-11-26)

Tool results that contain image blocks (screenshots, charts) are now visible to clients.

## Wire

A `function_call_output` item may carry `images`, an array of:

```json
{ "type": "output_image", "file_id": "timg_<sessionId>_<32 hex>", "filename": "...", "media_type": "image/png", "bytes": 1234, "width": 800, "height": 600 }
```

`output` stays a string, so OpenAI-shaped clients are unaffected. Fetch the bytes with `GET /v1/agents/files/{file_id}/content` (owner-scoped; `Cache-Control: private, max-age=3600`).

## How it works

- The id is `timg_` + session id + the first 32 hex of sha256(attachment id). It is deterministic, so live and replayed items agree and no database row is needed. Attachment ids never reach the wire.
- A second `FileSource` (after uploads) checks that the session belongs to the caller, re-reads the image references from the raw Session log (parent plus live subagents) and reads the bytes from the attachment service. Unknown id or other owner: 404. No attachment service: 503.
- Code: `src/files/tool-images.ts`, `src/items.ts`, `src/history/session-history.ts`, `src/gateway.ts`.

## Limits

- Subagent images are served only while the subagent is live (their items are live-only today).
- Shell (`command_execution`) results carry no images.
- Each content request scans the session log; fine for now.
