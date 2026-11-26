# Office files render to PDF (2026-11-26)

`GET /v1/agents/sessions/{id}/renders/pdf/{path}` converts a `doc`, `docx`, `xls`, `xlsx`, `ppt` or `pptx` file in the session's workspace to PDF, so the web panel can show decks and spreadsheets as pages.

## Route

- Owner check and path check as the artifacts route (`sanitizeRelativePath`). Another extension: 400 `unsupported_format`.
- The file is read where the session's files live: the sandbox (through envd, `fileStat` + `readFile`), the S3 artifact store, or the local workspace folder. Size first: over 50 MB answers 413 `file_too_large` without reading.
- 200 `application/pdf` with `ETag: "<size>:<mtime>"` and `X-Agentry-Missing-Fonts` (comma-separated, URL-encoded families) when the conversion lacked fonts. A matching `If-None-Match` answers 304 without converting.
- Errors (`src/render/office.ts`): 413 `file_too_large`, 422 `invalid_document`, 409 `source_changed`, 503 `render_unavailable` / `render_busy` (`Retry-After: 5`) / `sandbox_unavailable`, 504 `render_timeout`, 500 `render_failed`. Messages are plain; engine diagnostics are never sent.
- Closing the request cancels the conversion.

## Where conversion runs

In the API process, through DSH's `officeToPdf` service (`@deepseek-ai/dsh-office-to-pdf`, LibreOffice Kit as WASM on Linux), which the `dsh-web-app` bundle already mounts. It is optional and read at call time; absent means 503. Limits are DSH's defaults: 2 conversions at once, 60 s each, 50 MB in, 100 MB out. DSH caches PDFs by content (8 PDFs, 128 MB), so the API keeps no cache.

Spike (`tests/office-live.spec.ts`, `AGENTRY_LIVE_OFFICE=1`): a small pptx converts in about 3 s on a dev machine (first conversion, engine start included), peak RSS about 1.3 GB for the test process. The Docker image installs `@deepseek-ai/dsh` from npm, whose `libreoffice-kit` pulls `libreoffice-kit-wasm` as an optional dependency, so no Dockerfile change is needed; the slim image has no system fonts, so expect `X-Agentry-Missing-Fonts` (for example Arial) until fonts are added to the image.

Code: `src/render/office.ts`, `src/render/office-api.ts`, `src/gateway.ts` (`sessionFile`), `src/sandbox/agentry-sandbox-provider.ts` (`fileStat`).
