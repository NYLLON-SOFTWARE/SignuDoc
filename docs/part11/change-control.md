# Release and change control

SignuDoc has no numbered releases. Each commit on `main` is a version. Your install runs whichever commit you last pulled into your copy (see [Keep your install up to date](../self-hosting.md#keep-your-install-up-to-date)). Change control is about deciding which commit you run and showing that it still works.

## Evidence each version gives you

Every pull request and every push to `main` runs the project's CI (`.github/workflows/ci.yml`):

- **Typecheck, lint, unit tests, build**, which includes `npm test`.
- **End-to-end test**, which runs the database tests (`npm run test:db`) against a real Postgres and then the browser test (`npm run test:e2e`). The browser test includes a full Part 11 run: an admin turns the mode on, a send is refused until the signer's identity is confirmed, the signer signs with their password after one wrong try, and the audit exports are checked.

For a commit, the run on the GitHub Actions page is your test evidence. Save its link, or a PDF of the page, with the change record.

## Procedure for taking a new version

1. **Identify** the commit you want, and list the commits between it and the one you run now (`git log <current>..<new> --oneline`).
2. **Assess** which ones touch the files in the [traceability matrix](traceability-matrix.md). Any database migration (`db/migrations/`) is a change to the record structure and needs a closer look.
3. **Check** that CI passed for the new commit, and file the run link.
4. **Test** on a separate test install with **its own database and Blob store**, never on production data:
   - Use a second Vercel project with its own Neon database and Blob store, or set the Preview environment's database and storage variables to separate test resources. By default a preview deployment uses the same database as production, so testing on one would change real records.
   - A preview build does not apply migrations unless `MIGRATE_ON_PREVIEW=1` is set for the Preview environment. Set it only when previews have their own database.
   - Deploy the new commit there, and check in the build log that the migrations ran.
   - Re-run the [OQ](operational-qualification.md) scripts for every requirement a changed file touches.
   - Re-run OQ-04 and OQ-07 for any change at all.
5. **Approve** the change: who reviewed it, what was tested, any deviations, and the decision.
6. **Deploy** to production by merging the commit into your copy and pushing. Record the deployment's commit SHA and time from Vercel.
7. **Verify** after deployment: log in, check the install audit trail chain is intact, and open one finished Part 11 record.

## Emergency changes

For a security fix you can't wait to test, deploy it, record why, and complete steps 4 and 5 within `[N]` working days.

## Rolling back

Vercel can put an earlier deployment back with Instant Rollback. A rollback does not undo database migrations. Migrations here only add, so an older version normally runs on a newer database, but check before rolling back past a migration. Record every rollback as a change.

## Changes outside the code

The following are changes too, and go through the same record:

- environment variables;
- the Vercel, Neon or Resend plan or region;
- the seal certificate;
- a new administrator;
- turning Part 11 mode off or on.

Changes made inside SignuDoc are also in the install audit trail. Changes made in the hosting consoles are not, so record them yourself.
