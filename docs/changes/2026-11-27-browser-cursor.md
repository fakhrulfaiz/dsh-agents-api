# Browser live view: the agent's cursor (2026-11-27)

The live view is a CDP screencast, which has no pointer in it, and Playwright clicks over its own CDP connection, which the relay cannot see. The page still receives those mouse events, so the relay now listens for them inside the page.

- `POINTER_LISTENER_SOURCE` (`src/sandbox/browser-live-relay.ts`) is installed on the page the relay shows (`Runtime.addBinding` `__agentryPointer`, `Page.addScriptToEvaluateOnNewDocument`, `Runtime.evaluate`). Top frame only, trusted events only. It reports `mousemove` (one per 50 ms, latest wins), `mousedown`, `mouseup` and `focusin` on input, textarea, select and contenteditable.
- The relay checks every payload (finite numbers within 0..100000) and writes `{"type":"pointer","action","x","y","ts"}` and `{"type":"focus","x","y","width","height","ts"}`; at most 30 pointer lines a second, moves dropped first, down and up never.
- `BrowserLiveHub` passes them to readers as `LivePointer` / `LiveFocus`, and the live stream sends SSE events `pointer` and `focus`. They are not stored: a new reader gets no stale pointer. Frame, idle and control behavior is unchanged.
- Coordinates are viewport CSS pixels (`clientX`/`clientY`), the same as the frame and the take-over input.
- Out of scope: cross-origin iframes, scroll indicators.

Checked 2026-11-27 against the Chromium that ships with Playwright 1.65 (relay run on the host, page driven by Playwright): a click produced `move`, `down`, `up`, and clicking an input a `focus` line with its rect. `Runtime.bindingCalled` arrives without `Runtime.enable` on the page shown at attach, but not after a navigation: Chromium keeps the binding and the new-document script for the next document only when the session has enabled both `Runtime` and `Page`. Found in a live check through the API, sandbox and web app on 2026-11-27 (the cursor showed on the first page, then never again); the relay now enables both on attach. Not yet checked through a running API, sandbox and web app.
