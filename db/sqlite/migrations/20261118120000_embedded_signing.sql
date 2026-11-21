-- SQLite version of db/migrations/20261118120000_embedded_signing.sql: how an
-- envelope's signers get their links, the site an embedded link was made
-- for, and the sites allowed to frame the signing page. See that file for
-- what each column is.

alter table envelopes add column delivery text not null default 'email'
  constraint envelopes_delivery_check check (delivery in ('email', 'embedded'));

alter table signers add column embed_origin text;
alter table signers add column embed_link_opened_at bigint;

create table if not exists embed_allowed_origins (
  origin text not null primary key
    constraint embed_allowed_origins_origin_check check (length(origin) between 8 and 255),
  created_by text references "user" (id) on delete set null,
  created_at bigint not null
);
