-- First-class Projects group an owner's sessions. Mutable wire fields stay in
-- `body`; name, status, and pinned are copied out for filtering and ordering.
-- Sessions attach through a nullable project id; old rows stay unfiled.

create table projects (
  id text primary key,
  owner_id text not null references owners (id),
  body jsonb not null,
  name text not null,
  status text not null default 'active',
  pinned boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index projects_owner_created_idx on projects (owner_id, created_at desc);
create index projects_owner_status_pinned_created_idx on projects (owner_id, status, pinned, created_at desc);

alter table sessions add column project_id text references projects (id);
create index sessions_owner_project_created_idx on sessions (owner_id, project_id, created_at desc);
