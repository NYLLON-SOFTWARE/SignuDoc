# Development

How to run SignuDoc on your own machine, test it, and find your way around the code. For deploying and running an install, see the [self-hosting guide](self-hosting.md).

## Run it locally

For development, or to try it on your own machine first.

### 1. Install dependencies

```bash
npm install
```

SignuDoc targets Node.js 24 and is built on Next.js 16.

### 2. Create your environment file

```bash
cp .env.example .env
```

The example file is ready for local development as it is. Uploaded PDFs are kept on disk under `.data/storage` and outgoing email is written to `.data/outbox` as JSON files instead of being sent, so you need no storage or email account to try the whole product.

Every setting, and which ones are optional, is described in `.env.example`.

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

The first time you open the app it takes you to `/setup`, where you name the organization, give a support address and create the administrator. [Set the site up](self-hosting.md#set-the-site-up), in the self-hosting guide, explains each choice.

## Built with

- Next.js App Router
- React + TypeScript
- Better Auth
- Postgres (`pg`)
- Vercel Blob object storage (local disk in development)
- Resend for transactional email
- `pdf-lib` and `pdfjs-dist`
- Tailwind CSS 4 + shadcn/ui

## How the workflow fits together

1. Upload a PDF and create a draft envelope.
2. Add signers in the order they should receive it.
3. Place fields on the document.
4. Review and send.
5. The first signer receives a secure link.
6. Each signer completes their turn in order.
7. SignuDoc finalizes the signed PDF and audit certificate when the last signer finishes.

People added to receive a copy do not sign. They are sent the finished document and its certificate at step 7 and nothing before it.

A document you send often can be kept as a template: open any envelope, sent or not, and choose Save as template. The template keeps the document, the fields and the signing order, and no one's name or email address. Using it asks who signs this time and opens a draft at step 4.

## Storage

Documents, signed PDFs, audit certificates, drawn signature images, and the small first-page pictures shown on the dashboard are stored in one of two places:

- **Vercel Blob**, in a private store. This is used whenever a Blob store is connected to the project (Vercel sets `BLOB_READ_WRITE_TOKEN`, or `BLOB_STORE_ID` for a store that signs in with the project's OIDC token), and always on Vercel. Nothing in the store has a public URL; every download goes through the app, which checks who is asking first.
- **Local disk**, under `.data/storage` (change it with `STORAGE_LOCAL_DIR`). This is the default everywhere else, including local development.

`STORAGE_DRIVER=blob` or `STORAGE_DRIVER=local` overrides the choice.

On Vercel Blob, the upload page sends the PDF straight from the browser to the store with a short-lived signed URL, because a request to a Vercel Function cannot be larger than 4.5 MB. The upload lands in a pending folder, the app reads it back and validates it like any other upload, stores its own copy, and deletes the pending one. A pending upload that is never picked up is deleted by Blob after a day.

To run the end-to-end test against a real Blob store instead of local disk:

```bash
E2E_STORAGE_DRIVER=blob BLOB_READ_WRITE_TOKEN=... npm run test:e2e
```

## Database

SignuDoc uses Postgres as its only database and talks to it with `pg`. Any Postgres 15 or newer works, including Neon and Supabase.

The schema lives in `db/migrations` as plain SQL files. `npm run db:migrate` applies the ones that have not run yet and records them in the `signudoc_migrations` table, so it is safe to run on every deploy.

## Email delivery

SignuDoc sends transactional email through Resend.

- The support address, where replies go, is asked for when the site is set up. It and the address email is sent from can be changed by the administrator under Settings, Organization. The sender address must be at a domain verified with Resend; the same page adds the domain to Resend, lists the DNS records and checks them. With a Resend API key that is only allowed to send, it points you at Resend's dashboard for that step instead.
- `RESEND_FROM_EMAIL` and `SUPPORT_EMAIL` are optional. When set they take the place of the addresses saved in Settings, which then cannot be changed there, and with `SUPPORT_EMAIL` set the setup page does not ask for a support address.
- Until a sender address is set, mail goes out from `onboarding@resend.dev`, which Resend only delivers to the owner of the Resend account.
- In hosted mode the support address is also the contact shown on the Terms, Privacy, and Accessibility pages.
- For local development, `EMAIL_DRIVER=capture` writes each email to `.data/outbox` as a JSON file instead of sending it. Open the newest file to find a verification or signing link. This driver refuses to run in production.

## Upload constraints

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

`npm test` runs the unit tests, which need nothing else running. `npm run test:db` runs the few tests that need a real Postgres (the rate limit counter, the cleanup job's lock and first-run setup) against the `signudoc_e2e` database.

`npm run test:e2e` runs the Playwright end-to-end test. It starts the app against a separate `signudoc_e2e` database on the same Postgres server, sets the site up as its first visitor, signs up a sender, sends a PDF, signs it as the recipient and downloads the results. Install the browser once with `npx playwright install chromium`.

## Project structure

```text
src/app         Next.js routes, layouts, and API handlers
src/components  UI shells and reusable components
src/lib         Auth, database, services, schemas, and domain logic
db              SQL migrations and the script that applies them
e2e             The Playwright end-to-end test
public/pdfjs    PDF.js worker and standard font assets
```
