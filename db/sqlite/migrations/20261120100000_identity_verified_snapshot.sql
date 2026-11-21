-- SQLite version of db/migrations/20261120100000_identity_verified_snapshot.sql:
-- the name and address an administrator confirmed someone's identity under.
-- Accounts already confirmed keep their name and address of now.

alter table "user" add column identity_verified_name text;
alter table "user" add column identity_verified_email text;

update "user"
set
  identity_verified_name = name,
  identity_verified_email = email
where identity_verified_at is not null
  and identity_verified_name is null;
