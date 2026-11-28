-- Per-owner secrets (connector keys), sealed with AES-256-GCM under a key derived from
-- `secrets.key` (`AGENTRY_SECRETS_KEY`); `owner_id + name` is the authenticated data.
-- Only `last4` is ever shown.

create table owner_secrets (
  owner_id text not null references owners (id),
  name text not null,
  sealed text not null,
  last4 text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, name)
);
