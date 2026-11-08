-- The session's resolved setup (agent, environment, metadata, vault ids), kept so a restart can rebuild the agent.
-- It holds no conversation content and no model requests; those stay in the DSH Session log.
-- Rows written before this migration keep '{}' and cannot be resumed.

alter table sessions add column body jsonb not null default '{}';
