-- Installed skills (library and agent-private). Files live on disk under the
-- plugin's `skills.dir`; this table is the index. Names are unique per owner
-- across both scopes so `/name` never resolves two skills.

create table skills (
  id text primary key,
  owner_id text not null references owners (id),
  scope text not null check (scope in ('library', 'agent')),
  agent_id text,
  name text not null,
  description text not null,
  source text not null check (source in ('upload', 'github', 'editor', 'chat')),
  origin jsonb,
  content_hash text not null,
  has_scripts boolean not null,
  status text not null check (status in ('pending_review', 'active')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (owner_id, name),
  check ((scope = 'agent') = (agent_id is not null))
);
create index skills_owner_scope_agent_idx on skills (owner_id, scope, agent_id);
create index skills_status_updated_idx on skills (status, updated_at);
