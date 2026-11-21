-- SQLite version of db/migrations/20261119120000_fields_revision.sql: a
-- counter that goes up with every save of an envelope's fields.

alter table envelopes add column fields_revision integer not null default 0;
