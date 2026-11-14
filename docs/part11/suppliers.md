# Suppliers

A SignuDoc install on Vercel runs on three outside services. Your organization chooses them, signs their terms, and should assess them as suppliers of a GxP system. None of them is controlled by the SignuDoc project.

Check each supplier's current security reports and terms yourself. What they offer changes, and the plan you are on matters.

| Supplier                                                     | What it holds or does                                                                                                                         | What to get and check                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Vercel** (hosting)                                         | Runs the app and the daily cleanup job. Keeps build and runtime logs. Vercel Blob holds every PDF: originals, signed copies and certificates. | Its security report (such as SOC 2) and data processing terms. The regions your project and Blob store run in. Who in your organization is on the Vercel team. Whether your plan's log retention meets your needs. How you will back up the Blob store: plan a regular copy to storage you control.                                                                 |
| **Neon** (Postgres database, through the Vercel Marketplace) | Every record's data and both audit trails.                                                                                                    | Its security report and data processing terms. The region. **The point-in-time restore window on your plan**: a free plan's window is short, so use a plan with a window that meets your needs, or make your own regular `pg_dump`. Who can open the Neon console, because someone with full database access could change rows (see [risk R5](risk-assessment.md)). |
| **Resend** (email)                                           | Sends invitations, codes, lock alerts and completion emails. Keeps delivery logs.                                                             | Its security report and terms. That the sending domain is yours and verified. Email is a notification channel, not the record: the record is in the database and the PDFs.                                                                                                                                                                                          |

## Supplier assessment record

For each supplier, record:

- Supplier, service and plan: `[ ]`
- Data held: `[ ]`
- Region: `[ ]`
- Security evidence reviewed, such as a report and its date: `[ ]`
- Contract and data processing terms in place: `[ ]`
- Backup and restore arrangements: `[ ]`
- Who has access: `[ ]`
- Risk accepted by `[name, role, date]`
- Next review: `[date]`

## The SignuDoc project itself

SignuDoc is open-source software provided as is, without a supplier agreement or support commitment. Treat it as software you take responsibility for:

- the code is public, and you can review it;
- every version is tested in public CI;
- your organization does the validation in this pack.

Questions and problems go to the project's GitHub issues. Security problems go to private vulnerability reporting on the repository.
