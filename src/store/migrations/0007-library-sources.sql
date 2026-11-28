-- Agent library sources per owner: a label and a GitHub folder or gist link (`/agents/library/sources`).

create table library_sources (
  id text primary key,
  owner_id text not null references owners (id),
  body jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index library_sources_owner_created_idx on library_sources (owner_id, created_at desc);
