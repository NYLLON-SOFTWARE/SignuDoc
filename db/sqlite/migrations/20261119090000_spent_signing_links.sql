-- SQLite version of db/migrations/20261119090000_spent_signing_links.sql: the
-- hash of a signer's last link once it is used up, so opening it again can
-- say what happened.

alter table signers add column spent_signing_token_hash text;

create index if not exists idx_signers_spent_signing_token_hash
  on signers (spent_signing_token_hash)
  where spent_signing_token_hash is not null;
