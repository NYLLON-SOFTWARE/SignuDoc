-- SQLite version of db/migrations/20261119130000_consent_disclosure.sql: the
-- disclosure an administrator wrote. length() counts characters, as
-- char_length() does in Postgres.

alter table app_settings add column consent_disclosure text
  constraint app_settings_consent_disclosure_check check (
    consent_disclosure is null
    or length(consent_disclosure) between 1 and 6000
  );
