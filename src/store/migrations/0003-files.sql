-- Uploaded files. `staged` rows own bytes in the staging directory; `attached` rows reference
-- the DSH attachment store and the session workspace copy. No bytes live in Postgres.
-- `session_id` has no foreign key: the row is claimed after the session exists, and deleting a
-- session deletes its rows explicitly.

create table files (
  id text primary key,
  owner_id text not null references owners (id),
  name text not null,
  media_type text not null,
  bytes bigint not null,
  sha256 text not null,
  status text not null check (status in ('staged', 'attached')),
  session_id text,
  attachment_id text,
  attachment jsonb,
  workspace_path text,
  created_at timestamptz not null,
  attached_at timestamptz
);
create index files_owner_status_created_idx on files (owner_id, status, created_at);
create index files_owner_session_attachment_idx on files (owner_id, session_id, attachment_id);
