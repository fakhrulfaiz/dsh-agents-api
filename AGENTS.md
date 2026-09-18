# Agent rules — @deepseek-ai/dsh-experimental-agents-api

## Changelog is mandatory

Every behavior, API, docs-layout, or packaging change that lands on this repo **must** update:

1. **`CHANGELOG.md`** — dated section with short bullets.
2. **`docs/changes/YYYY-MM-DD-<slug>.md`** — durable write-up when the change needs more than a bullet (new capability, wire contract, limitation, or migration).
3. **`docs/README.md`** — add a row for each new `docs/changes/` note.

Do not ship a commit that changes product behavior or public docs without the changelog entry in the same commit (or the same PR). Pure typo/format-only fixes may skip a `docs/changes/` file but still get a one-line `CHANGELOG.md` note when the fix is user-visible.

Link the detailed note from the CHANGELOG section when one exists.
