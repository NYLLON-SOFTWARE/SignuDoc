# Installation qualification (IQ)

Run this for each new deployment, and again when you move an install to a new Vercel project, database or storage. Record who did each step and when, with a screenshot or link as evidence.

Install name: `[ ]` Web address: `[ ]` Performed by: `[ ]` Date: `[ ]`

## Version

| #     | Check               | Expected                                                                                     | Result | Evidence                |
| ----- | ------------------- | -------------------------------------------------------------------------------------------- | ------ | ----------------------- |
| IQ-01 | The deployed commit | A commit on `main` of `NYLLON-SOFTWARE/SignuDoc` (or your fork), recorded by its full SHA    |        | Vercel deployment page  |
| IQ-02 | CI for that commit  | "Typecheck, lint, unit tests, build" and "End-to-end test" passed                            |        | GitHub Actions run link |
| IQ-03 | Database migrations | The build log shows every migration applied, up to `20261115090000_part11_mode.sql` or later |        | Vercel build log        |

## Services

| #     | Check                 | Expected                                                                                                                                                            | Result | Evidence                                  |
| ----- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------- |
| IQ-04 | Database              | A Neon Postgres database, with the region and plan recorded, and its backup or point-in-time restore window noted                                                   |        | Neon console                              |
| IQ-05 | File storage          | A Vercel Blob store is connected to the project, and `STORAGE_DRIVER` is unset or `blob` (never `local` on Vercel)                                                  |        | Vercel project, Storage                   |
| IQ-06 | Email                 | Settings, Email shows email working. A test email arrives                                                                                                           |        | Screenshot                                |
| IQ-07 | Seal                  | The seal certificate is configured as your organization decided (the default install seal, or a CA-issued certificate in `SEAL_P12_BASE64` and `SEAL_P12_PASSWORD`) |        | Vercel environment variables (names only) |
| IQ-08 | Secrets               | `BETTER_AUTH_SECRET` is set, unique to this install, and not shared                                                                                                 |        | Environment variable list                 |
| IQ-09 | Password breach check | `PASSWORD_BREACH_CHECK` is not set to `off`                                                                                                                         |        | Environment variable list                 |
| IQ-10 | Time                  | Server times are UTC. Note the time source (Vercel's servers)                                                                                                       |        | This line                                 |
| IQ-11 | Access to the hosting | Only named people have access to the Vercel team, the Neon project and the Resend account, with the list attached                                                   |        | Member lists                              |

## Application

| #     | Check        | Expected                                                                                                          | Result | Evidence   |
| ----- | ------------ | ----------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| IQ-12 | Setup done   | The first administrator is a named person. The support address goes to a mailbox someone reads                    |        | Settings   |
| IQ-13 | Sign-up rule | Sign-up is limited to your email domain, or closed                                                                |        | Settings   |
| IQ-14 | Retention    | The retention period is empty                                                                                     |        | Settings   |
| IQ-15 | Part 11 mode | Turned on under Settings. The install audit trail shows "Part 11 mode changed: Turned on" and the chain is intact |        | Screenshot |

Approved for operational qualification by `[name, role, date]`.
