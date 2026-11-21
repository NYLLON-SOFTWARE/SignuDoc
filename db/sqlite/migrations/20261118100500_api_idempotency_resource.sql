-- SQLite version of db/migrations/20261118100500_api_idempotency_resource.sql:
-- the envelope a stored request made, while its answer is still being
-- written.

alter table api_idempotency add column resource_id text;
