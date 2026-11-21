# SQLite migrations

The SQLite version of every Postgres migration in `db/migrations` that came after the baseline (`../baseline.versions`), with the same file name. CI fails when one is missing. See [the design](../../../docs/design/database-backends.md#schema-and-migrations).
