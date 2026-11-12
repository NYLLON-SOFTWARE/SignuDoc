# SignuDoc

SignuDoc is a focused e-signature app for U.S. small businesses.

Upload a PDF, add signers in order, place fields, send secure signing links, and keep the final signed PDF plus an audit certificate in one place.

The open source project is designed to be self-hostable, and the hosted version is available at [signudoc.app](https://signudoc.app).

## Important notes

- SignuDoc is designed for U.S. small businesses and ordinary business agreements such as NDAs, SOWs, and vendor contracts.
- SignuDoc is not a law firm and does not provide legal advice. It does not determine whether a particular document is legally suitable for electronic signing.
- If you self-host SignuDoc, your install carries your organization's name, not SignuDoc's, and does not show SignuDoc's own terms, privacy, contact or accessibility pages. You are responsible for linking to your own terms and privacy policy (in Settings), setting your own support address, and making sure your deployment meets any applicable compliance, retention, or consent requirements.

## What it does

- Upload PDF documents
- Add up to 10 signers in routing order
- Place signature, initials, date, text, and checkbox fields
- Send secure signing links by email
- Let recipients sign without creating an account
- Track draft, sent, completed, declined, and voided envelopes
- Generate a final signed PDF and audit certificate
- Send manual reminders to the current signer
- Run on any Postgres database, locally or hosted

## Built with

- Next.js App Router
- React + TypeScript
- Better Auth
- Postgres (`pg`)
- Vercel Blob object storage (local disk in development)
- Resend for transactional email
- `pdf-lib` and `pdfjs-dist`
- Tailwind CSS 4 + shadcn/ui

## Getting started

### 1. Install dependencies

```bash
npm install
```

SignuDoc targets Node.js 24 and is built on Next.js 16.

### 2. Create your environment file

```bash
cp .env.example .env
```

The example file is ready for local development as it is, apart from `BETTER_AUTH_SECRET`, which you generate with `openssl rand -hex 32`. Locally, uploaded PDFs are kept on disk under `.data/storage` and outgoing email is written to `.data/outbox` as JSON files instead of being sent, so you need no storage or email account to try the whole product.

A value that still starts with `replace-with-` is treated as not set.

For production deployments:

- `APP_URL` and `BETTER_AUTH_URL` must be absolute HTTPS URLs.
- `APP_URL` and `BETTER_AUTH_URL` must not point at localhost.
- `BETTER_AUTH_SECRET` must be a strong secret. The app enforces a minimum length of 32 characters in production.
- Leave `EMAIL_DRIVER` unset, or set it to `resend`. The capture driver is for development only.
- Leave `STORAGE_DRIVER` unset. On Vercel, files go to the Blob store connected to the project. Anywhere else they are kept on the machine's disk, so that disk must persist between restarts.

At a minimum, you should review these groups:

- **App/Auth**: `APP_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`
- **Database**: `DATABASE_URL`
- **Storage**: nothing to set on Vercel once a Blob store is connected; `STORAGE_DRIVER` and `STORAGE_LOCAL_DIR` elsewhere
- **Email**: `EMAIL_DRIVER`, `RESEND_API_KEY`. The sender and support addresses are chosen in the app; `RESEND_FROM_EMAIL` and `SUPPORT_EMAIL` override them if set.
- **First run**: `SETUP_TOKEN` (optional), `HOSTED_MODE` (only for running SignuDoc as a public service)
- **Daily cleanup**: `CRON_SECRET` (optional, see [Daily cleanup](#daily-cleanup))
- **Bot protection**: `BOTID` (optional, Vercel only, see [Bot protection](#bot-protection))

See `.env.example` for the full list.

### 3. Start the database and apply the schema

With Docker installed, this starts Postgres and applies the migrations:

```bash
npm run db:start
```

If you already have a Postgres server, point `DATABASE_URL` at it and run the migrations on their own:

```bash
npm run db:migrate
```

### 4. Start the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### 5. Set the site up

The first time you open a new install it takes you to `/setup`. There you name your organization and create the first account, which becomes the administrator. After that the setup page is gone for good.

- **Who can sign up.** The install starts by letting people with an email address at the administrator's own domain create accounts (or nobody else, if the administrator used a public mailbox such as Gmail). The administrator can change this under Settings, Organization: people at listed domains, nobody, or anyone. People who are only sent a document to sign never need an account.
- **Email.** Settings, Organization also shows whether email is working. Until you verify a domain of your own with Resend, mail goes out from Resend's test address, which only reaches the owner of the Resend account. Enter a sender address at your domain and the page shows the DNS records to add and checks them for you.
- **`SETUP_TOKEN`.** A new install can be claimed by whoever opens it first. If its URL will be public before you get to it, set `SETUP_TOKEN` to a secret of your own and the setup page will ask for it.
- **An install from before this page existed** has accounts but no administrator. Set `SETUP_TOKEN`, sign in with the account that should be in charge, and open `/setup`. Sign-up stays open, as it was, until that administrator changes it.

### Hosted mode

`HOSTED_MODE=1` runs SignuDoc as a public service under its own name, the way [signudoc.app](https://signudoc.app) does: the landing page at `/`, the built-in terms, privacy, contact and accessibility pages, and sign-up open to anyone. Leave it unset for an install that belongs to one organization.

## Development notes

### Storage

Documents, signed PDFs, audit certificates, and drawn signature images are stored in one of two places:

- **Vercel Blob**, in a private store. This is used whenever a Blob store is connected to the project (Vercel sets `BLOB_READ_WRITE_TOKEN`, or `BLOB_STORE_ID` for a store that signs in with the project's OIDC token), and always on Vercel. Nothing in the store has a public URL; every download goes through the app, which checks who is asking first.
- **Local disk**, under `.data/storage` (change it with `STORAGE_LOCAL_DIR`). This is the default everywhere else, including local development.

`STORAGE_DRIVER=blob` or `STORAGE_DRIVER=local` overrides the choice.

On Vercel Blob, the upload page sends the PDF straight from the browser to the store with a short-lived signed URL, because a request to a Vercel Function cannot be larger than 4.5 MB. The upload lands in a pending folder, the app reads it back and validates it like any other upload, stores its own copy, and deletes the pending one. A pending upload that is never picked up is deleted by Blob after a day.

To run the end-to-end test against a real Blob store instead of local disk:

```bash
E2E_STORAGE_DRIVER=blob BLOB_READ_WRITE_TOKEN=... npm run test:e2e
```

### Database

SignuDoc uses Postgres as its only database and talks to it with `pg`. Any Postgres 15 or newer works, including Neon and Supabase.

The schema lives in `db/migrations` as plain SQL files. `npm run db:migrate` applies the ones that have not run yet and records them in the `signudoc_migrations` table, so it is safe to run on every deploy.

### Email delivery

SignuDoc sends transactional email through Resend.

- The address email is sent from, and the support address replies go to, are set by the administrator under Settings, Organization. The sender address must be at a domain verified with Resend; the same page adds the domain to Resend, lists the DNS records and checks them. With a Resend API key that is only allowed to send, it points you at Resend's dashboard for that step instead.
- `RESEND_FROM_EMAIL` and `SUPPORT_EMAIL` are optional. When set they take the place of the addresses saved in Settings, which then cannot be changed there.
- Until a sender address is set, mail goes out from `onboarding@resend.dev`, which Resend only delivers to the owner of the Resend account.
- In hosted mode the support address is also the contact shown on the Terms, Privacy, and Accessibility pages.
- For local development, `EMAIL_DRIVER=capture` writes each email to `.data/outbox` as a JSON file instead of sending it. Open the newest file to find a verification or signing link. This driver refuses to run in production.

### Upload constraints

Document import currently enforces these limits:

- PDF files only
- 20 MB maximum upload size
- password-protected or encrypted PDFs are rejected
- pure XFA or unsupported PDF variants are rejected

## Common scripts

```bash
npm run dev
npm run build
npm run start
npm run db:start
npm run db:stop
npm run db:reset
npm run db:migrate
npm run auth:generate
npm run lint
npm run typecheck
npm run format
npm run format:check
npm test
npm run test:db
npm run test:e2e
```

`npm test` runs the unit tests, which need nothing else running. `npm run test:db` runs the few tests that need a real Postgres (the rate limit counter and the cleanup job's lock) against the `signudoc_e2e` database.

`npm run test:e2e` runs the Playwright end-to-end test. It starts the app against a separate `signudoc_e2e` database on the same Postgres server, sets the site up as its first visitor, signs up a sender, sends a PDF, signs it as the recipient and downloads the results. Install the browser once with `npx playwright install chromium`.

## How the workflow fits together

1. Upload a PDF and create a draft envelope.
2. Add signers in the order they should receive it.
3. Place fields on the document.
4. Review and send.
5. The first signer receives a secure link.
6. Each signer completes their turn in order.
7. SignuDoc finalizes the signed PDF and audit certificate when the last signer finishes.

## Self-hosting

SignuDoc is set up for regular Next.js deployments and also uses Next.js standalone output.

A simple production flow looks like this:

```bash
npm run build
npm run start
```

If you want to deploy the standalone build directly, copy `public` and `.next/static` into `.next/standalone`, then run the generated server:

```bash
npm run build
cp -r public .next/standalone/
cp -r .next/static .next/standalone/.next/
node .next/standalone/server.js
```

Self-hosted operators are responsible for:

- linking to their own terms and privacy policy under Settings, Organization;
- setting the correct support address and verifying a sending domain for email;
- configuring retention, consent, and compliance requirements for their own deployment; and
- scheduling the [daily cleanup](#daily-cleanup) if they are not on Vercel, where it is scheduled for them.

## Daily cleanup

Once a day the app deletes drafts nobody has touched for 30 days, finishes account deletions that were requested, and clears expired download links and finished rate limit counters. The work is done by a request to:

```text
/api/internal/retention
```

- **On Vercel** this is already scheduled: `vercel.json` has a cron job that calls it once a day. There is nothing to set up.
- **Anywhere else**, have your own scheduler send it a `GET` or `POST` once a day.

A new install has no secret for this route, so the route looks after itself: it runs at most once an hour, never twice at the same time, and answers with an empty response either way. Someone who finds the URL can only make the day's cleanup happen earlier.

To close the route, set a secret. A caller then has to send `Authorization: Bearer <secret>`, and gets a summary of what was cleaned up in return.

- `CRON_SECRET` is the one to use on Vercel, because Vercel sends it on its own cron calls.
- `RETENTION_JOB_SECRET` does the same for a scheduler of your own. On Vercel, a deployment that sets only this one turns Vercel's cron call away, so store the secret as `CRON_SECRET` there instead.

## Rate limits

Sign-in, sign-up, password reset, the signing pages, uploads and sending are rate limited per visitor. The counts are kept in the `rate_limits` table in Postgres, so they hold across every instance of the app. On Vercel the visitor's address is read from the header Vercel sets itself, which a visitor cannot forge. If the database cannot be reached, each instance falls back to counting in its own memory.

## Bot protection

The app can use [Vercel BotID](https://vercel.com/docs/botid), an invisible check that a request comes from a real browser, on the requests a script would go for: creating an account, signing in, asking for a password reset or verification email, the contact form and first-run setup.

It is off by default. To turn it on, set `BOTID=1` on a Vercel deployment and redeploy; the setting is read when the app is built. BotID's basic check is free on every Vercel plan, and its deeper check is a paid option you switch on in the Vercel dashboard. It does nothing anywhere other than Vercel.

It is opt-in for now because it has not yet been proven against a live Vercel deployment. If you turn it on, try signing in from a private window straight away, and remove `BOTID` and redeploy if that fails. A check that cannot reach Vercel lets the request through, so an outage on that side does not lock people out; the rate limits apply either way.

## Project structure

```text
src/app         Next.js routes, layouts, and API handlers
src/components  UI shells and reusable components
src/lib         Auth, database, services, schemas, and domain logic
public/pdfjs    PDF.js worker and standard font assets
```

## License

SignuDoc is licensed under the MIT License. See [LICENSE](./LICENSE).

This repository also redistributes third-party assets, including bundled fonts and PDF.js runtime assets, under their own licenses. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for details.

## Contributing

Issues and pull requests are welcome.

If you plan to contribute, keep the project style simple: small components, explicit server-side logic, and schema-validated inputs.
