# Backup and restore

This backup and restore procedure applies to Vercel Blob installs. The daily backup copies Postgres records (accounts, envelopes, audit trails, settings) and Blob files (PDFs, sealed copies and certificates) to a second Vercel Blob store.

For an S3 install, enable bucket versioning and set up independent backups of the bucket and Postgres. See [Self-hosting](self-hosting.md#use-an-s3-compatible-bucket).

## What you have without doing anything

- **Neon** keeps the database's history for a restore window and can restore it to a point in time, or branch from it, from the Neon console. The window is short on the free plan and longer on paid plans; see Neon's plan page for the current numbers. It protects against a bad change, not against losing the Neon project or account.
- **Vercel Blob** has no versions or recycle bin. A deleted file is gone.

So the daily backup is worth turning on for any install whose documents matter. It is optional, and you set it up by hand.

## Turn on the daily backup

The backup copies the install, once a day, to a second Blob store that you keep apart from the first.

1. **Make the backup store.** In Vercel, go to Storage, Create, Blob, and make a **private** store. Make it in a different Vercel team from the install if you can, so that losing the install's team, or an admin there, does not take the backup with it. Do not connect it to the install's project.
2. **Copy its read-write token.** In the new store, open its settings (or `.env.local` snippet) and copy `BLOB_READ_WRITE_TOKEN`. It starts with `vercel_blob_rw_`.
3. **Give it to the install.** In the install's Vercel project, under Settings, Environment Variables, add `BACKUP_BLOB_READ_WRITE_TOKEN` with that token, for Production. Mark it Sensitive.
4. **Set `CRON_SECRET`** too, if you have not already (any long random string), so only Vercel's own cron call can start a backup.
5. Deploy again.

From then on Vercel calls `/api/internal/backup` every day at 08:00 UTC (see `vercel.json`). Each run:

- writes the whole database, read as one consistent snapshot, to `database/<time>.ndjson.gz` in the backup store, and keeps `BACKUP_KEEP_DAYS` days of them (30 unless you set it, and never fewer than the newest three);
- copies every file that is new or changed since the last run to `files/<same path>`. A run copies for up to four minutes; a first backup of a large install may take a few days to catch up, and each later run only copies what changed;
- keeps the copy of a file that was deleted from the install (by the retention rules, for example) for `BACKUP_KEEP_DAYS` more days, then removes it, so the backup does not hold a document much longer than your retention rules allow.

To run one by hand (while cron jobs are paused, for example), call the same address with the secret: `curl -H "Authorization: Bearer $CRON_SECRET" https://<your install>/api/internal/backup`.

Each run writes a `backup_finished` line to the function logs (with the counts), or `backup_failure` if it failed. With a log drain, alert on those. The app refuses a token for its own store, because that backup would not survive what it is for.

**Cost.** The backup store holds about as much as the install's store, plus the database copies. On a Vercel Hobby account, a second store in the same account counts against the same free Blob storage, so it halves how much your install can hold for $0. A store in another team has its own allowance. Each copied file is one upload to the backup store.

**Check it works.** After the first run, open the backup store in Vercel and look for `database/` and `files/`. Every few months, do a test restore (below) into a throwaway Neon project, so you know the steps before you need them.

## Restore

A restore goes into a **new, empty** database and Blob store, never over a live install. You can then point the install at them, or deploy a new install on them.

You need a computer with Node.js 24 and a copy of this repository at the same version as the install (or newer).

1. Make a new Neon database (a new Neon project, or a new branch with no data) and copy its connection string.
2. Make a new private Blob store for the restored files and copy its read-write token. Or, if the install's store still exists and only the database was lost, use `--skip-files` and skip this.
3. In the repository folder:

   ```sh
   npm ci
   export DATABASE_URL='postgres://…'               # the new, empty database
   export BLOB_READ_WRITE_TOKEN='vercel_blob_rw_…'   # the new Blob store
   export BACKUP_BLOB_READ_WRITE_TOKEN='vercel_blob_rw_…'
   npm run restore-backup -- --list                  # see which backups there are
   npm run restore-backup                            # restore the newest one
   ```

   `--backup database/<name>` restores an older one instead. The script applies the migrations, loads the database in one transaction (so a failed restore leaves nothing half done), then copies the files back to their own paths. It refuses a database that already has accounts in it, and a backup made by a newer SignuDoc than the copy you are running. If copying the files stops part way (a network error, or you stopped it), run `npm run restore-backup -- --files-only` to finish: it skips the database and every file that is already there.

4. Connect the new database and Blob store to the install's Vercel project (or a new one) in place of the old ones, keep `BETTER_AUTH_SECRET` the same as before, and deploy. Two-step sign-in keys are encrypted with that secret, and session cookies are signed with it; if it changes, everyone is signed out, and nobody who used two-step sign-in can finish signing in until their setup is cleared (see the note on two-step sign-in in [self-hosting](self-hosting.md#sign-in-security)).
5. Sign in, open a finished document, and check its audit trail and download.

What a restore brings back: everything in the database at the time of the backup, and every file as of the last run. A document sent after the last backup is not in it. The hash chains in both audit trails come back exactly as they were, so they still verify.

What a restore does not bring back: anything that lets someone in. A backup holds sign-ins and links as they were when it was made, including ones that were signed out, used or replaced since, so the restore ends them all:

- Everyone signs in again, and password reset links and emailed codes from before the restore stop working.
- Every signing link stops working. For each envelope still out for signature, send a reminder from its page: that emails the signer a new link. The usual wait between reminders starts over with the restore, so you can send one at once. Embedded envelopes get no reminders: the app that shows them asks for a new link through the API's [embed-link endpoint](api.md#embedded-signing).
- A signature that was under way at a signing provider has to be started again.

Passwords and API keys come back as they were at the time of the backup. If someone changed a password, or an administrator revoked an API key, after the backup was made, do it again. If the restore follows a break-in, also change `BETTER_AUTH_SECRET` (everyone using two-step sign-in then sets it up again, see step 4).

## In a security review

- **Backup frequency:** daily, at 08:00 UTC.
- **Retention:** `BACKUP_KEEP_DAYS` (30 by default) for database copies and deleted files.
- **Location and access:** a private Vercel Blob store chosen by the deployer, ideally in another Vercel team. Only its read-write token can read it.
- **Encryption:** Vercel Blob encrypts stored data at rest (see Vercel's security documentation). The database copy holds the same data as the database, including password hashes and the encrypted two-step sign-in keys, so treat the backup store's token like the database password.
- **Restore testing:** the procedure above, run by the deployer on a schedule they choose.
