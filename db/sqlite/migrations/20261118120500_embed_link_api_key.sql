-- SQLite version of db/migrations/20261118120500_embed_link_api_key.sql: the
-- API key an embedded signing link was asked for with.

alter table signers add column embed_api_key_id text
  references api_keys (id) on delete set null;
