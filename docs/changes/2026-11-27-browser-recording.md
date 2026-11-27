# Browser recording (2026-11-27)

Design: `agentry-web/docs/superpowers/specs/2026-11-27-browser-recording-design.md`. Builds on the live view (`2026-11-27-browser-live.md`), the cursor events (`2026-11-27-browser-cursor.md`) and per-sandbox DevTools ports (`2026-11-27-browser-port-and-task-folders.md`).

## What the agent gets

Two function tools, registered in `gateway.ts` `mountBrowser()` right after the browser MCP mounts (so only in a sandbox chat whose agent has the browser on, or on auto with a sandbox that has it; not when the MCP mount throws). Code: `src/mount-browser-recording.ts`.

| Tool | Answer |
|---|---|
| `browser_recording_start({ name? })` | `{ recording: true, path, cursor_path, max_minutes, max_megabytes }`, paths relative to the workspace (`recordings/<name>.webm`, `recordings/<name>.cursor.jsonl`) |
| `browser_recording_stop()` | `{ path, cursor_path, duration_seconds, size_bytes, reason }` |

Refusals come back as `{ error, message }`: `already_recording`, `not_recording`, `browser_not_started` (no page is open: open one first), `recording_unavailable` (the image has no ffmpeg), `recording_failed`, `too_many_live_views` (the owner's live-view limit; a recording holds one view).

`name` is cleaned to letters, digits, `.`, `_`, `-` (at most 80); the default is `recording-<yyyymmdd-hhmmss>` (UTC). A taken name gets `-2`, `-3`, ... (decided in the sandbox, so the answer carries the real path).

The browser guidance section gains one line while the tools are present: record only when the user asks for a video, start before the steps, stop when done, mention the path.

## How it records

- **In the sandbox, from the relay's frames.** The relay (`src/sandbox/browser-live-relay.ts`, part `RELAY_RECORD_SOURCE`) accepts `{"type":"record","on":true,"path","cursorPath","maxMs","maxBytes"}` and `{"type":"record","on":false}` on stdin. A start must name a `.webm` directly inside `AGENTRY_LIVE_RECORDINGS_DIR` (the workspace's `recordings/`, set by the API when it starts the relay) with the cursor file beside it; anything else answers `{"type":"record","state":"error","code":"bad_record_command"}`. The relay answers `started`, `stopped` (with `reason`, `durationMs`, `bytes`, `frames`, `empty`) or `error` lines, which the hub passes only to the recorder, never to live-view readers.
- **ffmpeg.** The first `/opt/ms-playwright/ffmpeg-*/ffmpeg-linux` (or `AGENTRY_LIVE_FFMPEG`). Spawned on the first frame, with the video size fitted from that frame's viewport into 1280 x 960 (even numbers). Every 100 ms the relay writes the latest JPEG as many times as the wall clock says are due, so the video has a fixed 10 fps and pauses keep their real length. The frame shown when the recording starts is written first (a static page sends no new frames).
- **Cursor sidecar** (`<name>.cursor.jsonl`, JSON lines): `{"type":"meta","version":1,"fps":10,"started_at"}`, then `{"t":0,"type":"viewport","width","height","video_width","video_height"}` at the first frame and a `viewport` line whenever the page size changes, and one line per `pointer` (`action`, `x`, `y`) and `focus` (`x`, `y`, `width`, `height`) event. `t` is milliseconds from the first frame (= video time); coordinates are viewport CSS pixels. The video itself has no cursor.
- **Keeping the relay alive.** `BrowserLiveHub.attachRecorder` adds the recording as a reader of the session's view (so the relay runs with no viewer, and counts toward the owner's live-view limit) plus a listener of `record` lines; the recorder (`src/sandbox/browser-recording.ts`) releases it when the recording ends.

## Auto-stop

- **Limits**: the relay stops by itself after `maxMs` (15 minutes) or once the file reaches `maxBytes` (200 MB, checked once a second), when ffmpeg exits, and before the relay exits (stdin closed or SIGTERM).
- **Turn end**: `AgentsGateway.applySessionEvent` sees the root session's `turn/end` (the same event that ends the sandbox changed-files turn) and calls `BrowserRecorder.turnEnded(sessionId)`, which sends the stop. The turn's end snapshot in `SandboxChanges` waits for that stop (`hold`), so the finished file lands in this turn's changed files.
- A recording that stopped without `browser_recording_stop` is logged (`agents-api: browser recording ... stopped ...`) and reported in the next recording tool result: `browser_recording_stop` answers with it (plus a `note`), and `browser_recording_start` adds it as `earlier_recording`.
- Deleting the session stops its recording (the file stays). If the relay itself dies, the hub reports `relay_ended` and the recording ends with whatever ffmpeg wrote.

## Verified ffmpeg arguments

Checked 2026-11-27 with the ffmpeg in `ghcr.io/fakhrulfaiz/agentry-sandbox-browser:1` (`/opt/ms-playwright/ffmpeg-1011/ffmpeg-linux`; it has the `mjpeg` decoder, `image2pipe` demuxer, `libvpx` VP8 encoder, `webm` muxer and `scale`/`pad`/`crop`, but no VP9, which is why Playwright 1.65's current VP9 arguments do not apply). `recordingFfmpegArgs(W, H)`:

```
-loglevel error -f image2pipe -avioflags direct -fpsprobesize 0 -probesize 32 -analyzeduration 0
-framerate 10 -c:v mjpeg -i pipe:0 -y -an -r 10
-c:v vp8 -qmin 0 -qmax 50 -crf 8 -deadline realtime -speed 8 -b:v 1M -threads 1
-vf scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2:gray,format=yuv420p
-f webm <path>.webm
```

Checks run in throwaway containers of that image:

1. 40 Chromium JPEG screenshots piped in (4 frames, each repeated 10 times, the last one a smaller 400 x 300 frame) gave a 640 x 480 VP8 WebM of 3.9 s at 10 fps; Chromium played it (`canPlayType('video/webm; codecs="vp8"')` = `probably`), and seeking to 2.5 s showed the third frame's colour.
2. The real relay program next to a real Chromium (`--remote-debugging-port`): a bad path was refused, a 2.5 s session (a static second, a click, typing, a mouse move, a colour change) gave an 800 x 600 VP8 WebM (2.4 s by ffmpeg's count, 25 frames written) and a cursor file with the move, down, focus, up and move lines at the right offsets.

## Not done (v1)

- The cursor is not baked into the video; a downloaded file has none.
- No live check through a running API and web app yet.
- The time and size limits are fixed in code (`BrowserRecorderOptions`), not in config.
