# SignuDoc

SignuDoc is an e-signature app you can run for your own organization.

Upload a PDF, add signers in order, place fields, send secure signing links, and keep the final signed PDF plus an audit certificate in one place.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FNYLLON-SOFTWARE%2Fsignudoc&project-name=signudoc&repository-name=signudoc&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%2C%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%2C%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22resend%22%2C%22productSlug%22%3A%22resend-email%22%2C%22protocol%22%3A%22messaging%22%7D%5D&demo-title=SignuDoc&demo-description=Your%20own%20e-signature%20site.%20Upload%20a%20PDF%2C%20place%20fields%2C%20send%20signing%20links%2C%20and%20keep%20the%20signed%20copy%20with%20its%20audit%20certificate.&demo-url=https%3A%2F%2Fgithub.com%2FNYLLON-SOFTWARE%2Fsignudoc&demo-image=https%3A%2F%2Fraw.githubusercontent.com%2FNYLLON-SOFTWARE%2Fsignudoc%2Fmain%2Fdocs%2Fimages%2Fprepare.png)

The button puts your own copy on [Vercel](https://vercel.com) with a Postgres database, private file storage and email already connected. There is no terminal to open and nothing to type in.

![Placing a signature field on a document in SignuDoc](docs/images/prepare.png)

## Deploy your own

1. **Click "Deploy with Vercel"** above.
2. **Sign in to Vercel** and let it copy this repository into your GitHub account. Your site is built from that copy.
3. **Add the three things Vercel offers to create.** Each has a free plan:
   - a Postgres database from [Neon](https://neon.com) (pick the region closest to you),
   - a private file store, [Vercel Blob](https://vercel.com/docs/vercel-blob), for the documents,
   - [Resend](https://resend.com) for sending email.
4. **Click Deploy.** The build creates the database tables by itself.
5. **Open your new site.** It takes you to a setup page, where you name your organization, give the email address people should write to for help, and create the first account. That account is the administrator.
6. **Set up the address you send from.** Under Settings, Organization, enter an address at your own domain in "Send email from" and save (the setup page offers the same field). The site lists the DNS records for that domain and checks them for you. Add them where your domain is managed. If your Resend key is not allowed to manage domains, the page sends you to Resend's dashboard for this step instead.

![The setup page of a new install](docs/images/setup.png)

Step 6 is the one part that cannot be done for you: every email provider asks for proof that you own the domain you send from. While "Send email from" is empty, email goes out from Resend's test address, which Resend delivers only to the email address of the Resend account itself, normally the one on your Vercel account. So to try the whole product straight away, leave that field empty and send a document to that address. Once you save an address of your own, email is sent from it, and Resend does not deliver it until the domain shows as verified. Add the records before you count on it.

If the site opens on a page that says to connect a database, the database was not connected when the site was built. Connect it under Storage in the Vercel project, deploy again and reload.

### What it costs

- **Vercel.** The free Hobby plan is enough to run SignuDoc, but Vercel [limits Hobby to personal, non-commercial use](https://vercel.com/docs/limits/fair-use-guidelines). An organization using this for its work belongs on Vercel Pro. Everything here works the same on both.
- **Neon, Vercel Blob and Resend** each have a free plan with limits: see [Neon](https://neon.com/faqs/free-plan-limits-and-quotas), [Vercel Blob](https://vercel.com/docs/vercel-blob/usage-and-pricing) and [Resend](https://resend.com/pricing). The one you are most likely to meet first is Resend's, which at the time of writing allows 100 emails a day and 3,000 a month on its free plan. Every signing invitation, reminder and completed copy is an email.

### Use your own web address

Add your domain to the project in Vercel (Settings, Domains), then deploy once more. The site works out its own address from the project's production domain, so the links in its emails follow the new domain after that deployment. Nothing needs to be set by hand.

### Lock down a new install

A new install is claimed by whoever opens it first. That is normally you, seconds after the deployment finishes. If its address will be known to others before you get there, add a `SETUP_TOKEN` environment variable in Vercel with a secret of your own and deploy again: the setup page then asks for it.

### Keep your install up to date

The Deploy button makes a copy of this repository, and a copy does not receive new versions by itself. To take a new version, bring the changes into your copy and push. Vercel builds the push, and the build applies any new database migrations.

```bash
git clone https://github.com/<your-account>/signudoc.git
cd signudoc
git remote add upstream https://github.com/NYLLON-SOFTWARE/signudoc.git
git fetch upstream
git merge upstream/main
git push
```

If git answers `refusing to merge unrelated histories`, your copy was made without this project's history. As long as you have not changed the code yourself, take the new version as it is:

```bash
git reset --hard upstream/main
git push --force-with-lease
```

After that first time, `git merge upstream/main` works as above.

### Optional settings

A deployment made with the button needs no environment variables. These are there if you want them, under Settings, Environment Variables in the Vercel project. Deploy again after changing one.

| Variable                               | What it does                                                                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SETUP_TOKEN`                          | A secret the setup page asks for. See [Lock down a new install](#lock-down-a-new-install).                                                                  |
| `CRON_SECRET`                          | Closes the daily cleanup route to everyone but Vercel's own cron call. See [Daily cleanup](#daily-cleanup).                                                 |
| `BOTID`                                | `1` turns on Vercel BotID for sign-in, sign-up and setup. See [Bot protection](#bot-protection).                                                            |
| `RESEND_FROM_EMAIL`, `SUPPORT_EMAIL`   | Fix the sender and support addresses from the environment instead of in Settings.                                                                           |
| `BETTER_AUTH_SECRET`                   | Your own secret for signing sessions. Without it one is derived from the database password, so changing that password signs everyone out.                   |
| `APP_URL`                              | The site's public address, if it should not be the project's production domain.                                                                             |
| `HOSTED_MODE`                          | `1` runs SignuDoc as a public service under its own name. See [Hosted mode](#hosted-mode).                                                                  |
| `RESEND_REGION`                        | Where Resend sends from when the app adds your domain, for example `eu-west-1`. See [Running in the EU](#running-in-the-eu).                                |
| `SEAL_P12_BASE64`, `SEAL_P12_PASSWORD` | Seal finished PDFs with a certificate from a certificate authority instead of the install's own. See [Signed PDFs and the seal](#signed-pdfs-and-the-seal). |
| `SEAL_TIMESTAMP_URL`                   | An RFC 3161 timestamp server that adds a trusted time to each seal.                                                                                         |

## Important notes

SignuDoc is not a law firm and does not give legal advice. Whoever runs an install decides what it may be used for. Every install has a page at `/electronic-signatures` that says what follows, and senders confirm it before each send.

### What SignuDoc is for

- Ordinary business agreements: sales and service contracts, NDAs, statements of work, offer letters, purchase orders, approvals.
- In the US, signatures made with it are electronic signatures under the federal ESIGN Act and the state UETA laws (New York: ESRA). Each signer first agrees to use electronic records, and that agreement is recorded.
- In the EU and UK, they are **simple electronic signatures (SES)** under eIDAS. A court cannot reject them only for being electronic, but you may have to show who signed. The sealed PDF, the audit certificate and the optional access code or emailed code help.

### What SignuDoc is not

- **Not an advanced or qualified electronic signature (AdES or QES)** under eIDAS. Where a law asks for a QES, use a qualified trust service.
- **Not built for FDA 21 CFR Part 11** records.
- **Not HIPAA-ready.** Do not send protected health information without your own agreements with every service the install runs on.
- **Not for documents the law keeps out of electronic signature**, such as wills, family-law matters, court orders, and notices of foreclosure, eviction, utility shut-off or insurance cancellation (ESIGN section 103, UETA section 3), and in most EU countries real estate transfers and documents that need a notary.

### Your responsibilities when you self-host

Your install carries your organization's name, not SignuDoc's. In Settings, link your own terms and privacy policy (without a privacy link, signers see a notice built from your settings at `/signer-privacy`; check it), keep the support address you gave at setup pointed at a mailbox someone reads, and choose how long finished documents are kept. Under GDPR your organization is the controller; Settings, Organization has the tools to answer a signer who asks for their data or for its erasure.

## Signed PDFs and the seal

Every finished PDF and audit certificate is sealed with a PAdES signature, so any change after signing shows in Adobe Acrobat and other PDF readers, and its SHA-256 is recorded. Anyone can check a copy at `/verify`. The audit trail in the database is a hash chain, so an edited or deleted row shows too.

By default each install makes its own seal key and self-signed certificate the first time it seals, and keeps the key encrypted in the database with a key derived from `BETTER_AUTH_SECRET` (or the database password, when that is unset). Keep that secret stable: a new one makes a new seal key, and old PDFs still verify but under the old certificate. Readers show a self-signed seal as "validity unknown" until the certificate is trusted. For a seal readers trust on sight, buy a document-signing certificate and set `SEAL_P12_BASE64` and `SEAL_P12_PASSWORD`. `SEAL_TIMESTAMP_URL` adds a trusted time from a timestamp server.

## Running in the EU

By default the parts of an install run in the US. To keep signers' data in the EU:

1. **Functions.** Add `"regions": ["fra1"]` to `vercel.json` (or pick Frankfurt under Settings, Functions in the Vercel project).
2. **Database.** Create the Neon database in an EU region (Frankfurt) when you connect it.
3. **Files.** Create the Vercel Blob store in an EU region (Frankfurt).
4. **Email.** Set `RESEND_REGION=eu-west-1` before you add your domain in Settings, or create the domain in Resend's dashboard with the Ireland region. Resend still keeps account data and email logs in the US.
5. **Agreements.** Accept the data processing agreements of Vercel, Neon and Resend, which include the EU standard contractual clauses, and list them in your privacy policy.

Some data still leaves the EU: Vercel's and Resend's account metadata and logs, for example. The processors' agreements and the EU-US Data Privacy Framework cover that, but check it against your own obligations.

## What it does

- Upload PDF documents
- Add up to 10 signers in routing order, and people who only receive a copy of the finished document
- Place signature, initials, date, text, number, checkbox, dropdown, and radio button fields
- Save a document as a template, and send it again by naming who signs this time
- Send secure signing links by email
- Let recipients sign without creating an account
- Give each envelope its own signing deadline, and change it while the envelope is out
- Track draft, sent, completed, declined, voided, and expired envelopes
- Generate a final signed PDF and audit certificate, with names and text in Latin, Greek, Cyrillic, Chinese, Japanese, and Korean scripts
- Send a reminder to the current signer yourself, or have one sent every few days
- Put your organization's logo and color on the site, the signing pages, and the emails
- Have more than one administrator
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

The first time you open a new install it takes you to `/setup`. There you name your organization, give its support address, and create the first account, which becomes the administrator. After that the setup page is gone for good.

- **Support address.** Setup does not finish without one. It is the address signers and people with an account are told to write to, and where replies to the site's emails go. It is saved in your install's own settings and nowhere else; there is no SignuDoc address that it falls back to. The administrator can change it under Settings, Organization, but not remove it.

- **Who can sign up.** The install starts by letting people with an email address at the administrator's own domain create accounts (or nobody else, if the administrator used a public mailbox such as Gmail). The administrator can change this under Settings, Organization: people at listed domains, nobody, or anyone. People who are only sent a document to sign never need an account.
- **More administrators.** Settings, Organization lists everyone with an account under People, where an administrator can make someone else an administrator or take that away. There is always at least one. When an account is closed, its finished documents and their audit trails move to the longest-standing administrator, because they are the organization's records. If that person later stops being an administrator, those documents move on to one who stays, and the documents they sent themselves stay with them.
- **Email.** Settings, Organization also shows whether email is working. While no sender address is set, mail goes out from Resend's test address, which only reaches the owner of the Resend account. Enter a sender address at your domain and the page shows the DNS records to add and checks them for you. Mail from that address is not delivered until its domain is verified.
- **`SETUP_TOKEN`.** A new install can be claimed by whoever opens it first. If its URL will be public before you get to it, set `SETUP_TOKEN` to a secret of your own and the setup page will ask for it.
- **An install from before this page existed** has accounts but no administrator. Set `SETUP_TOKEN`, sign in with the account that should be in charge, and open `/setup`. It asks for a support address if the install has none. Sign-up stays open, as it was, until that administrator changes it.

### Hosted mode

`HOSTED_MODE=1` runs SignuDoc as a public service under its own name: the landing page at `/`, the built-in terms, privacy, contact and accessibility pages, and sign-up open to anyone. Leave it unset for an install that belongs to one organization.

## Development notes

### Storage

Documents, signed PDFs, audit certificates, drawn signature images, and the small first-page pictures shown on the dashboard are stored in one of two places:

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

- The support address, where replies go, is asked for when the site is set up. It and the address email is sent from can be changed by the administrator under Settings, Organization. The sender address must be at a domain verified with Resend; the same page adds the domain to Resend, lists the DNS records and checks them. With a Resend API key that is only allowed to send, it points you at Resend's dashboard for that step instead.
- `RESEND_FROM_EMAIL` and `SUPPORT_EMAIL` are optional. When set they take the place of the addresses saved in Settings, which then cannot be changed there, and with `SUPPORT_EMAIL` set the setup page does not ask for a support address.
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

`npm test` runs the unit tests, which need nothing else running. `npm run test:db` runs the few tests that need a real Postgres (the rate limit counter, the cleanup job's lock and first-run setup) against the `signudoc_e2e` database.

`npm run test:e2e` runs the Playwright end-to-end test. It starts the app against a separate `signudoc_e2e` database on the same Postgres server, sets the site up as its first visitor, signs up a sender, sends a PDF, signs it as the recipient and downloads the results. Install the browser once with `npx playwright install chromium`.

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

## Self-hosting somewhere else

SignuDoc is a regular Next.js app and runs anywhere Node.js 24 and Postgres do:

```bash
npm run db:migrate
npm run build
npm run start
```

Away from Vercel, a few things Vercel does for you are yours to set:

- `DATABASE_URL`, pointing at your Postgres. Run `npm run db:migrate` on every deploy; it only applies what is new.
- `APP_URL`, the site's public HTTPS address.
- `BETTER_AUTH_SECRET`, at least 32 characters (`openssl rand -hex 32`). Without it a secret is derived from the database password, which must then be at least 12 characters long.
- `RESEND_API_KEY`, from your Resend account.
- Files are kept on the machine's disk under `.data/storage` (`STORAGE_LOCAL_DIR` changes where), so that disk must survive restarts. To use a Vercel Blob store from elsewhere, set `BLOB_READ_WRITE_TOKEN`.
- Leave `EMAIL_DRIVER` unset. The capture driver is for development only.

Self-hosted operators are responsible for:

- linking to their own terms and privacy policy under Settings, Organization;
- keeping the support address pointed at a mailbox someone reads, and verifying a sending domain for email;
- configuring retention, consent, and compliance requirements for their own deployment; and
- scheduling the [daily cleanup](#daily-cleanup) if they are not on Vercel, where it is scheduled for them.

## Daily cleanup

Once a day the app deletes drafts nobody has touched for 30 days, finishes account deletions that were requested, and clears expired download links and finished rate limit counters. The same run sends the automatic reminders that are due and tells a sender when an envelope has passed its signing deadline. The work is done by a request to:

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
db              SQL migrations and the script that applies them
e2e             The Playwright end-to-end test
public/pdfjs    PDF.js worker and standard font assets
```

## License

SignuDoc is licensed under the MIT License. See [LICENSE](./LICENSE).

This repository also redistributes third-party assets, including bundled fonts and PDF.js runtime assets, under their own licenses. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for details.

## Contributing

Issues and pull requests are welcome.

If you plan to contribute, keep the project style simple: small components, explicit server-side logic, and schema-validated inputs.

The project has no email address of its own. Report a security problem privately through GitHub, as [SECURITY.md](./SECURITY.md) describes, and a conduct problem as the [Code of Conduct](./CODE_OF_CONDUCT.md) describes. For help with one particular site that runs SignuDoc, write to the organization that runs it.
