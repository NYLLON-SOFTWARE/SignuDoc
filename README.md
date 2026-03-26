# SignuDoc

SignuDoc is a focused e-signature app for U.S. small businesses.

Upload a PDF, add signers in order, place fields, send secure signing links, and keep the final signed PDF plus an audit certificate in one place.

The open source project is designed to be self-hostable, and the hosted version is available at [signudoc.app](https://signudoc.app).

## Important notes

- SignuDoc is designed for U.S. small businesses and ordinary business agreements such as NDAs, SOWs, and vendor contracts.
- SignuDoc is not a law firm and does not provide legal advice. It does not determine whether a particular document is legally suitable for electronic signing.
- If you self-host SignuDoc, you are responsible for replacing the legal pages (`/terms`, `/privacy`, `/contact`, `/accessibility`) with your own content, setting your own support contact details, and making sure your deployment meets any applicable compliance, retention, or consent requirements.

## What it does

- Upload PDF documents
- Add up to 10 signers in routing order
- Place signature, initials, date, text, and checkbox fields
- Send secure signing links by email
- Let recipients sign without creating an account
- Track draft, sent, completed, declined, and voided envelopes
- Generate a final signed PDF and audit certificate
- Send manual reminders to the current signer
- Run with Supabase Postgres for local and hosted deployments

## Built with

- Next.js App Router
- React + TypeScript
- Better Auth
- Supabase Postgres (`pg`)
- Cloudflare R2 object storage
- Resend for transactional email
- `pdf-lib` and `pdfjs-dist`
- Tailwind CSS 4 + shadcn/ui

## Getting started

### 1. Install dependencies

```bash
npm install
```

SignuDoc currently targets Node.js 20.9+ and is built on Next.js 16.

### 2. Create your environment file

```bash
cp .env.example .env
```

Then fill in the values in `.env`.

The app now requires explicit values for every env-backed dependency. Leaving placeholders in place is treated as unconfigured, and the related feature will fail when used.

For production deployments:

- `APP_URL` and `BETTER_AUTH_URL` must be absolute HTTPS URLs.
- `APP_URL` and `BETTER_AUTH_URL` must not point at localhost.
- `BETTER_AUTH_SECRET` must be a strong secret. The app enforces a minimum length of 32 characters in production.

At a minimum, you should review these groups:

- **App/Auth**: `APP_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`
- **Database**: `DATABASE_URL`
- **Storage**: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`
- **Email**: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SUPPORT_EMAIL`
- **Internal jobs**: `RETENTION_JOB_SECRET`

See `.env.example` for the full list.

### 3. Apply the database schema

This repo already includes the committed `supabase/` directory and migrations.

For a hosted Supabase project, link the repo to your project and push the schema:

```bash
npx supabase link --project-ref <your-project-ref>
npm run db:push
```

If you prefer local Supabase development, Docker is required:

```bash
npm run db:start
```

### 4. Start the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Development notes

### Storage

Documents, signed PDFs, audit certificates, and drawn signature images are stored in Cloudflare R2 using its S3-compatible API.

### Database

SignuDoc uses Supabase Postgres as its only database. The checked-in `supabase/config.toml` is Postgres-only for local development; Supabase Auth, Storage, Realtime, Edge Runtime, and Inbucket are disabled because SignuDoc uses Better Auth, Cloudflare R2, and Resend.

This repo already includes the committed `supabase/` directory and migrations.

For a hosted Supabase project:

```bash
npx supabase link --project-ref <your-project-ref>
npm run db:push
```

Then point `DATABASE_URL` at the Supabase connection string from the dashboard. Because SignuDoc uses a persistent `pg.Pool` in a long-lived Next.js server, use a **Direct connection** string by default. If your network requires IPv4, use the **Session pooler** instead. Avoid the Transaction pooler, which is designed for serverless/edge workloads.

If you want a local Supabase stack instead, Docker is required and the local DB URL is typically:

```bash
postgresql://postgres:postgres@localhost:54322/postgres
```

### Email delivery

SignuDoc sends transactional email through Resend only.

- `RESEND_FROM_EMAIL` must use a verified Resend sending domain or subdomain.
- `SUPPORT_EMAIL` is used as the default reply-to address for outbound mail **and** as the public support contact displayed on the Terms, Privacy, and Accessibility pages. If it is missing, those pages will fail to render.
- There is no local email outbox fallback. If email env values are missing or still placeholder-like, email flows fail when used.

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
npm run db:push
npm run auth:generate
npm run lint
npm run typecheck
npm run format
npm run format:check
```

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

- replacing the bundled legal pages with deployment-specific terms, privacy, contact, and accessibility content;
- setting the correct public support address and email-delivery configuration;
- configuring retention, consent, and compliance requirements for their own deployment; and
- scheduling the internal retention job if they want automatic stale-draft cleanup and queued account purges.

## Retention job

The app includes an internal retention endpoint for scheduled cleanup.

It removes stale draft artifacts and processes queued account-closure purges.

Trigger it with a `POST` request to:

```text
/api/internal/retention
```

using:

```text
Authorization: Bearer <RETENTION_JOB_SECRET>
```

This is a good candidate for a cron job in production.

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
