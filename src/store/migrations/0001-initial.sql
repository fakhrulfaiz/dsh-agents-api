-- Agentry-owned records. Items, turns, and steps stay in the DSH Session log.

create table owners (
  id text primary key,
  created_at timestamptz not null default now()
);

create table agents (
  id text primary key,
  owner_id text not null references owners (id),
  body jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index agents_owner_created_idx on agents (owner_id, created_at desc);

create table environment_templates (
  id text primary key,
  owner_id text not null references owners (id),
  body jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index environment_templates_owner_created_idx on environment_templates (owner_id, created_at desc);

create table environments (
  id text primary key,
  owner_id text not null references owners (id),
  provider text not null,
  status text not null,
  workspace_path text,
  body jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index environments_owner_created_idx on environments (owner_id, created_at desc);

create table sessions (
  id text primary key,
  owner_id text not null references owners (id),
  agent_id text,
  environment_id text,
  dsh_session_id text not null,
  status text not null,
  last_error text,
  model text not null,
  reasoning_effort text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index sessions_owner_created_idx on sessions (owner_id, created_at desc);
create index sessions_status_idx on sessions (status);

create table admin_audit (
  id bigserial primary key,
  actor text not null,
  action text not null,
  target text not null,
  at timestamptz not null
);
