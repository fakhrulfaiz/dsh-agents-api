# Session metadata merge and filter (2026-11-26)

## Problem

`POST /agents/sessions/{id}` replaces the whole `metadata` map, as in the OpenAI contract. A client that stars a chat reads the map, adds a key and writes it back; two such writers (starring while a title is set) drop each other's keys. The session list could not be filtered by metadata, so a "starred" view only saw the pages the client had loaded.

## Decision

- **Merge as a separate body field, `metadata_merge`.** `{ "metadata_merge": { "starred": "true", "color": null } }` sets `starred`, deletes `color` (`null`), and keeps every other key. `metadata` keeps its replace meaning, so OpenAI-compatible clients are unaffected.
- Why not a header or a new route: a field is visible in the request body, in logs and in the OpenAPI schema; a header changes the meaning of a field with the same name and is easy to lose in proxies and tests; a route (`PATCH`) adds surface for one operation. An additive, optional field breaks nothing and is the least surprising.
- Both fields in one request: `metadata` replaces first, then `metadata_merge` applies.
- **Atomic.** A merge-only request does not write the whole row. The store runs one statement (`jsonb_set(body, '{metadata}', jsonb_strip_nulls(body->'metadata' || patch))`) on the stored value, so two concurrent merges of different keys both survive. Metadata values are strings, so stripping nulls only removes the deleted keys. The same-key race is last-writer-wins.
- **Filter.** `GET /agents/sessions?metadata[key]=value` (deepObject form). Several keys must all match exactly. In Postgres: `body->'metadata' @> $filter::jsonb`, applied before the cursor and limit, so every page is complete.

## Limits

Values are strings only. A request that changes `agent` fields and `metadata_merge` together writes the settings first and then merges, as two steps. The filter has no index; it scans the owner's sessions (fine for one owner; add a GIN index on `body->'metadata'` if lists grow large).
