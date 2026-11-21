# The SignuDoc API

Another app can use SignuDoc through its API: create an envelope from a
PDF, send it, follow it, and download the signed PDF and the certificate of
completion.
Everything here runs inside your own install; nothing goes through a
service of ours.

The API is version 1 and lives under `/api/v1` on your install, for example
`https://sign.example.com/api/v1`. Within version 1, endpoints, fields and
error codes are only ever added, never changed or removed.

## Keys

An administrator makes a key under **Settings, Organization, API keys**:

1. Give it a name that says which app uses it, such as "Billing app".
2. Choose **Read and write** (create, send and void envelopes, and read
   them) or **Read only**.
3. Choose when it expires: in 30 days, 90 days, a year, or never.
4. Copy the key. It starts with `sdk_` and is shown only this once; SignuDoc
   keeps only a hash of it.

Send the key in the `Authorization` header of every request:

```sh
curl https://sign.example.com/api/v1/me \
  -H "Authorization: Bearer sdk_…"
```

```json
{
  "key": { "id": "…", "name": "Billing app", "scope": "write" },
  "user": { "email": "ops@example.com", "id": "…", "name": "Ops" }
}
```

What to know about keys:

- **A key acts as the administrator who made it.** Envelopes it creates are
  theirs and show in their documents, sent in their name. An app that should
  send in its own name gets its own administrator account (for example
  "Billing app", with a shared mailbox) and its key from there.
- **A key stops working** the moment it is revoked, when it expires, when
  its administrator stops being an administrator, or when their account is
  being closed. A key that stopped because its administrator lost the role
  stays revoked if they get it back; make a new one.
- **Single sign-on does not reach keys.** On an install where people sign
  in only through single sign-on (`PASSWORD_SIGN_IN=off`), removing someone
  at your identity provider stops them signing in, but they are still an
  administrator here, so the keys they made keep working. When an
  administrator leaves, take the role away under Settings, Organization,
  People, which revokes their keys, or revoke the keys under API keys, which
  lists every administrator's keys. An app's keys made from its own
  administrator account, as above, do not depend on anyone staying.
- **Keys skip two-step sign-in.** They are for servers, so keep them in your
  app's secret settings (for example a Vercel environment variable), never
  in a browser or a mobile app, and revoke a key as soon as it may have
  leaked. The `sdk_` prefix makes a leaked key easy to search for. Secret
  scanners do not know it out of the box, but one that takes custom
  patterns can be given `sdk_[A-Za-z0-9_-]{43}`.
- Each administrator can have up to 25 keys that have not been revoked or
  expired.
- Making and revoking keys is recorded in the site audit trail (Settings,
  Organization, Sign-in security), and each key shows when it was last used.

## Errors

Every error has the same shape, and the code is meant for your program:

```json
{
  "error": {
    "code": "unauthorized",
    "message": "Send a valid API key as \"Authorization: Bearer sdk_…\"."
  }
}
```

| Status | Code                     | Meaning                                                                                  |
| ------ | ------------------------ | ---------------------------------------------------------------------------------------- |
| 400    | `invalid_request`        | The request is missing something or has a value that is not allowed.                     |
| 401    | `unauthorized`           | No key, or one that is unknown, revoked or expired. All of these look the same.          |
| 403    | `forbidden`              | The key may not do this, such as a read-only key asked to send.                          |
| 404    | `not_found`              | There is no such thing, or the key's administrator cannot see it.                        |
| 409    | `wrong_state`            | Not possible in the envelope's current state, such as sending one that was sent already. |
| 413    | `payload_too_large`      | The file is too big, or a JSON-only request is over 64 KB.                               |
| 422    | `idempotency_key_reused` | An `Idempotency-Key` was used before with a different request.                           |
| 429    | `rate_limited`           | Too many requests. Wait the number of seconds in `Retry-After`.                          |
| 500    | `internal_error`         | Something went wrong on the install. Try again later.                                    |
| 503    | `internal_error`         | Email is not set up on the install yet, so nothing was sent. Try again once it is.       |

## Rate limits

Each key may make 600 requests in 10 minutes. Every response says where it
stands:

- `RateLimit-Limit`: requests allowed in the window.
- `RateLimit-Remaining`: requests left in it.
- `RateLimit-Reset`: seconds until the window starts again.

On top of that, each key may create 60 envelopes in 10 minutes and send 100
in an hour, counting creates and template calls that also send. A retry that
gets its first answer again, through an `Idempotency-Key`, counts against
neither. Your email
provider's own limits usually bite first: Resend's free plan sends 100
emails a day. An address that sends 30 bad keys in 10 minutes gets 429 for
any more bad keys until the 10 minutes are up. Good keys from it keep
working.

## A first envelope in one call

Upload the PDF, name the signers, place the fields, and send, all at once.
`data` is the envelope as JSON:

```sh
curl https://sign.example.com/api/v1/envelopes \
  -H "Authorization: Bearer sdk_…" \
  -H "Idempotency-Key: order-1042" \
  -F file=@agreement.pdf \
  -F 'data={
    "title": "Service agreement",
    "signers": [
      { "ref": "client", "name": "Casey Client", "email": "casey@example.com" }
    ],
    "fields": [
      { "signer": "client", "type": "signature", "page": 1,
        "x": 0.1, "y": 0.8, "width": 0.3, "height": 0.05 },
      { "signer": "client", "type": "date", "page": 1,
        "x": 0.5, "y": 0.8, "width": 0.2, "height": 0.03 }
    ],
    "metadata": { "invoice": "INV-1042" },
    "send": { "expiresInDays": 14, "permittedUseConfirmed": true }
  }'
```

The answer is the envelope (see [The envelope](#the-envelope)), with status
`sent`, and the first signer has their invitation email (every signer of the
first step, when signers share one). Leave out `send` to
make a draft and send it later with `POST /api/v1/envelopes/{id}/send`.

Things to know:

- **Signers** sign in the order given, one after the other. To have some sign
  at the same time, give every signer a `step` (1, 2, 3, ...): signers who
  share a step are invited together, sign in any order, and the next step
  starts once they all have. Each signer has a `ref`, your own name for them
  (letters, digits, `.`, `_`, `:` and `-`), which fields use to say whose they
  are and which comes back with the signer. Up to 25 signers, or as many as
  the install sets with `MAX_SIGNERS_PER_ENVELOPE` (up to 100; the
  `maxItems` in `/api/v1/openapi.json` says), and up to 10 `copyRecipients`
  (`name`, `email`) who get the finished document.
  `accessCode` and `requireEmailCode: true` add the same extra checks the web
  app offers. On a Part 11 install, give each signer a `signatureMeaning`
  (`approval`, `review`, `responsibility` or `authorship`) before sending.
- **Fields** are placed on a page by fractions of its width and height from
  its top left corner: `"x": 0.1, "y": 0.8` is 10% in from the left and 80%
  down. Types: `signature`, `initials`, `date`, `name` (filled in with the
  signer's name when they sign), `text`, `checkbox`, `number`, `dropdown`
  (with `options`), `radio` (buttons with one `groupId` are one question). `required` is true unless set to false. Every signer needs at
  least one `signature` field.
- **Sending** needs `"permittedUseConfirmed": true`: your app confirms, as the
  web app's send button asks a person to, that the envelope is an ordinary
  business agreement and not one of the kinds of document that the law does
  not let be signed electronically (see `/electronic-signatures` on your
  install). `expiresInDays` (1 to 365) and `reminderIntervalDays` (1 to 30)
  are as in the web app, and `signatureLevel` is `advanced` or `qualified` on
  installs with a signing provider. `"delivery": "embedded"` sends no
  emails and has your app show the signing page instead (see
  [Embedded signing](#embedded-signing)); the default is `"email"`.
- **All or nothing.** If anything about the request is wrong, a field off
  its page or a signer without a signature field, nothing is kept: no
  half-made draft is left behind.
- **`metadata`** is up to 2 KB of JSON of your own, returned with the
  envelope, for matching it to your records.
- **`Idempotency-Key`** makes a retry safe. A request with a key SignuDoc has
  seen in the last 24 hours gets the first answer again (with the header
  `Idempotent-Replayed: true`) instead of making a second envelope. The same
  key with a different request is refused with 422. If the install fails
  after the envelope was made, a retry with the same key gets that envelope
  rather than a second one. Use one key per thing you mean to send, such as
  the invoice number.

### PDFs over 4 MB

On Vercel a request to the app can carry at most 4.5 MB, so a bigger PDF (up
to 20 MB) goes straight to storage first:

```sh
curl -X POST https://sign.example.com/api/v1/uploads -H "Authorization: Bearer sdk_…"
# {"uploadId": "…", "url": "https://…", "method": "PUT",
#  "headers": {"content-type": "application/pdf"}, "expiresAt": "…"}

curl -X PUT "<url>" -H "content-type: application/pdf" --data-binary @big.pdf
```

Then create the envelope with JSON instead of a form, naming the upload:

```sh
curl https://sign.example.com/api/v1/envelopes \
  -H "Authorization: Bearer sdk_…" -H "content-type: application/json" \
  -d '{ "uploadId": "…", "filename": "big.pdf", "title": "…", "signers": […], "fields": […] }'
```

The upload URL works for 10 minutes, and an upload that is never used is
deleted after a day. Installs that keep files on their own disk (not on
Vercel) do not need this and answer 404: send PDFs of up to 20 MB in the
form.

## The envelope

Every endpoint that returns an envelope returns the same object:

```json
{
  "object": "envelope",
  "id": "8c1d…",
  "title": "Service agreement",
  "status": "sent",
  "expired": false,
  "createdAt": "2026-11-17T09:00:00.000Z",
  "sentAt": "2026-11-17T09:00:01.000Z",
  "completedAt": null,
  "declinedAt": null,
  "voidedAt": null,
  "expiresAt": "2026-12-01T09:00:01.000Z",
  "pageCount": 2,
  "signatureLevel": "simple",
  "delivery": "email",
  "metadata": { "invoice": "INV-1042" },
  "signers": [
    {
      "id": "51ab…",
      "ref": "client",
      "name": "Casey Client",
      "email": "casey@example.com",
      "order": 1,
      "step": 1,
      "role": "signer",
      "status": "notified",
      "viewedAt": null,
      "signedAt": null,
      "declinedAt": null,
      "declineReason": null
    }
  ],
  "copyRecipients": [],
  "files": { "signed": null, "certificate": null }
}
```

- `status` is `draft`, `sent`, `completed`, `declined` or `voided`. A sent
  envelope past its deadline has `expired: true` until it is voided or the
  deadline moves.
- A signer's `status` is `pending` (not their turn yet), `notified` (their
  turn, invited), `signed` or `declined`. `step` is their step of the signing
  order: signers who share one sign at the same time. `viewedAt` is when they
  first opened it. `role` is `signer`, or `approver` for someone who reviews
  the document and approves or rejects it instead of signing (see
  [Signing order](signing-order.md)): an approval shows as `signed` and a
  rejection as `declined`.
- `delivery` is `email` (signers are invited by email) or `embedded` (your
  app shows the signing page, see [Embedded signing](#embedded-signing)).
- `files` gives the paths to download once there is something to download:
  the signed PDF once the envelope is completed, and the certificate of
  completion once it is completed, declined or voided.

To know when something happens without asking again and again, use
[webhooks](#webhooks).

## Endpoints

| Method and path                                             | Access | What it does                                                                                                                                                                                            |
| ----------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/me`                                            | read   | Which key this is and whom it acts as.                                                                                                                                                                  |
| `POST /api/v1/envelopes`                                    | write  | Creates an envelope, and sends it if asked.                                                                                                                                                             |
| `GET /api/v1/envelopes`                                     | read   | Lists envelopes, newest first: `?status=`, `?limit=` (up to 100, 25 by default), and `?cursor=` with the `nextCursor` of the page before.                                                               |
| `GET /api/v1/envelopes/{id}`                                | read   | One envelope.                                                                                                                                                                                           |
| `POST /api/v1/envelopes/{id}/send`                          | write  | Sends a draft. Body: the `send` options above.                                                                                                                                                          |
| `POST /api/v1/envelopes/{id}/void`                          | write  | Voids a sent envelope. Body: `{"reason": "…"}`, required on Part 11 installs.                                                                                                                           |
| `POST /api/v1/envelopes/{id}/remind`                        | write  | Emails a reminder to each signer whose turn it is, at most once a day as in the web app. Too soon gets 429 with `Retry-After`.                                                                          |
| `POST /api/v1/envelopes/{id}/signers/{signerId}/embed-link` | write  | A signing link for an embedded envelope, to show in a frame. Body: `{"origin": "https://…"}`. See [Embedded signing](#embedded-signing).                                                                |
| `DELETE /api/v1/envelopes/{id}`                             | write  | Deletes a draft.                                                                                                                                                                                        |
| `GET /api/v1/envelopes/{id}/events`                         | read   | The audit trail, oldest first.                                                                                                                                                                          |
| `GET /api/v1/envelopes/{id}/files/signed`                   | read   | The signed PDF.                                                                                                                                                                                         |
| `GET /api/v1/envelopes/{id}/files/certificate`              | read   | The certificate of completion.                                                                                                                                                                          |
| `POST /api/v1/uploads`                                      | write  | An upload URL for a PDF over 4 MB.                                                                                                                                                                      |
| `GET /api/v1/templates`                                     | read   | Saved templates, with their roles in signing order.                                                                                                                                                     |
| `POST /api/v1/templates/{id}/envelopes`                     | write  | An envelope from a template: `title`, `signers` (`name`, `email`, and `signatureMeaning` on Part 11 installs, one per role in order), and optionally `metadata` and `send`. Takes an `Idempotency-Key`. |
| `GET /api/v1/webhook-deliveries`                            | read   | Webhook deliveries, newest first, with the payload each carried: `?since=` (ISO time), `?type=`, `?status=`, `?limit=`, `?cursor=`. See [Webhooks](#webhooks).                                          |
| `GET /api/v1/openapi.json`                                  | none   | The OpenAPI 3.1 description of all of this, for code generators and API tools.                                                                                                                          |

Envelopes made through the API are ordinary envelopes: they show in the key's
administrator's documents, can be followed and voided there, and their audit
trail records the key that sent them.

## Webhooks

A webhook tells your app the moment an envelope changes, so it does not
have to ask. An administrator adds an endpoint under Settings,
Organization, Webhooks: an `https://` URL, the events it wants, and an
optional description. The signing secret (`whsec_…`) is shown once, then.
"Send test" sends a `webhook.test` event at once and says how your app
answered.

Endpoints belong to the whole install: each one gets events for every
envelope, whoever sent it. `data.owner` says whose envelope it is, so an app
can ignore the ones that are not its own. An install can have 10 endpoints.

### Events

| Event                | When                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `envelope.sent`      | The envelope was sent. `data.signer` is the first signer, now invited.                       |
| `signer.viewed`      | A signer opened it for the first time.                                                       |
| `signer.signed`      | A signer signed, or an approver approved. `data.signer` is who.                              |
| `envelope.completed` | Everyone signed. The signed PDF and the certificate are ready to download when this arrives. |
| `envelope.declined`  | A signer declined, or an approver rejected. `data.reason` is the reason they gave, if any.   |
| `envelope.voided`    | The sender voided it. `data.reason` is why, if given.                                        |
| `envelope.expired`   | Its deadline passed before everyone signed.                                                  |

### What arrives

Each event is a `POST` with a JSON body:

```json
{
  "type": "signer.signed",
  "timestamp": "2026-11-18T09:14:03.000Z",
  "data": {
    "envelope": { "object": "envelope", "id": "…", "status": "sent", "…": "…" },
    "owner": { "id": "…", "email": "ops@example.com", "name": "Ops" },
    "signer": { "id": "…", "ref": "client", "status": "signed", "…": "…" }
  }
}
```

`data.envelope` is the same [envelope](#the-envelope) the API returns, as it
was when the event was first sent.

### Checking the signature

Deliveries follow [Standard Webhooks](https://www.standardwebhooks.com), so
you can check them with one of its libraries instead of your own code. Each
carries three headers:

- `webhook-id`: the delivery's id (`msg_…`). The same on every try, so use
  it to ignore a delivery you already handled.
- `webhook-timestamp`: when this try was sent, in seconds since 1970.
  Refuse one more than five minutes old.
- `webhook-signature`: `v1,` and the base64 HMAC-SHA256 of
  `{webhook-id}.{webhook-timestamp}.{body}`, keyed with the secret's bytes
  (the base64 after `whsec_`). Check it against the raw body, before you
  parse it.

Without a library, in Node.js:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function isFromSignuDoc(headers, rawBody, secret) {
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  const signatures = headers["webhook-signature"];

  if (!id || !timestamp || !signatures) {
    return false;
  }

  // Written this way round so a timestamp that is not a number fails too.
  if (!(Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300)) {
    return false;
  }

  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const expected = Buffer.from(
    `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64")}`,
  );

  // During a secret rotation there are two signatures, space separated.
  return signatures.split(" ").some((signature) => {
    const given = Buffer.from(signature);

    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
```

"New secret" in Settings makes a new secret and shows it once. For 24 hours
after that, deliveries are signed with both the old and the new one, so you
can switch without missing any. Another new secret can be made once those
24 hours are over, so the old one always gets its full day. To replace a
secret sooner, for example one that leaked, remove the endpoint and add it
again.

### Answers and retries

Store or queue the event first, then answer with any `2xx` within 10
seconds and do the slow work after. A `2xx` counts as delivered, so an
event your app answered but did not keep is not sent again. Any other
answer, a redirect, or no answer counts as a failure, and the delivery
is tried again 1 minute, 5 minutes, 30 minutes, 2 hours, 8 hours, 24 hours
and 24 hours later, about two and a half days in all. After the eighth try
it is marked failed. A delivery whose envelope has since been deleted is
not sent again. The delivery log in Settings shows the last 100
deliveries per endpoint, with your app's answer, and "Send again" puts a
delivered or failed one back in line.

Retries go out when something wakes the install: the next change to any
envelope, the next API call, or the daily cron job. On Vercel's Hobby plan
crons run once a day, so on a quiet install a retry can wait until the next
day. On Pro you can run it more often by changing the schedule of
`/api/internal/webhooks` in `vercel.json`, for example to `*/5 * * * *`.

If your app was down, `GET /api/v1/webhook-deliveries?since=…` lists what
it missed, with the same payloads. `since` counts from when each delivery
was queued, which is when its event happened, not when it was sent.
Deliveries can arrive out of order, as one can still be retrying while a
later one gets through, so the newest event your app has is not a safe
`since`. Give a time from before anything it may have missed, for example
three days before it went down (retries take about two and a half days),
and skip what it already has by its `webhook-id`. Times are kept to the
second, so a `since` with a fraction counts from the start of its second.
Deliveries are kept 30 days after they are delivered, and otherwise 90
days after their last try or "Send again".

### Safety

The URL must be `https://` and must not point at a private, loopback or
link-local address. The address is checked each time a delivery is sent,
and the request goes to the address that was checked. Redirects are not
followed. For a receiver on your own machine while developing, set
`WEBHOOK_ALLOW_PRIVATE_URLS=1`; it allows `http://` and local addresses,
and is ignored on Vercel.

Signing secrets are stored encrypted with a key derived from
`BETTER_AUTH_SECRET`. If that secret changes, deliveries fail with a note
to make a new secret in Settings.

## Embedded signing

With embedded signing, a signer signs inside your own app instead of
following a link in an email. Your app signs the person in, asks SignuDoc
for a signing link, and shows it in a frame on its page. SignuDoc emails
no invitations or reminders for these envelopes. When an envelope is
finished, the signers, copy recipients and sender get the finished document
by email as usual.

### Allow your site

An administrator lists the sites that may show signing pages, under
Settings, Organization, Embedded signing: one exact origin each, such as
`https://app.example.com`, with no path, up to 10. Until at least one site
is listed, embedded sends are refused. Adding and removing sites is in the
site audit trail. Every other page of SignuDoc can never be framed.

Only list sites you trust. Your app, not an email address, decides who
signs an embedded envelope, so the certificate of completion says the
signer was identified by the app that sent it (it names the API key) and
signed in a page on its site.

### Send for embedded signing

Send as usual with `"delivery": "embedded"` in `send`:

```json
"send": { "delivery": "embedded", "permittedUseConfirmed": true }
```

Embedded envelopes are simple electronic signatures with no extra checks:
`accessCode`, `requireEmailCode`, `signatureLevel` other than `simple`, and
Part 11 mode are refused, because your app is the check. They get no
reminders (`/remind` answers 409) and their signers cannot be corrected
after sending; void and send a new one instead.

### Show the signing page

When it is a signer's turn (their `status` is `notified`), ask for a link:

```sh
curl https://sign.example.com/api/v1/envelopes/8c1d…/signers/51ab…/embed-link \
  -H "Authorization: Bearer sdk_…" \
  -H "Content-Type: application/json" \
  -d '{"origin": "https://app.example.com"}'
```

```json
{
  "object": "embed_link",
  "url": "https://sign.example.com/embed/sign/…?origin=https%3A%2F%2Fapp.example.com",
  "expiresAt": "2026-11-18T09:15:00.000Z"
}
```

Put `url` in a frame on the page at `origin`, exactly as it came, with its
`origin` parameter:

```html
<iframe
  src="https://sign.example.com/embed/sign/…?origin=https%3A%2F%2Fapp.example.com"
  title="Sign your agreement"
  style="width: 100%; height: 800px; border: 0"
></iframe>
```

- `origin` must be one of the allowed sites, and the page opens only inside
  a frame on that site: browsers refuse to show it anywhere else.
- A link must be opened within 15 minutes. Once opened, it lasts up to 4
  hours, or until the envelope's deadline if that is sooner. Ask for a new
  link each time you show the page; a new link replaces the signer's last
  one.
- Changing the envelope's deadline never makes a link last longer, though
  an earlier deadline still cuts it short.
- Removing a site from the list stops every link made for it at once,
  even one that is open. Ask for a new link for a site that is still
  allowed.
- A signer who is not yet at their turn gets 409. With several signers, the
  next step's turns start once everyone in the step before has signed, and
  signers who share a step are all `notified` at once: watch for the
  `signer.signed` webhook, whose `data.envelope` shows who is `notified`
  now.
- Asking for links is limited to 300 per 10 minutes per key. Past that the
  answer is 429 with `Retry-After`.

### Hear what happened

The frame tells your page when the signer is done, with `postMessage` sent
only to your origin:

```js
window.addEventListener("message", (event) => {
  if (event.origin !== "https://sign.example.com") return;

  switch (event.data.type) {
    case "signudoc:signed": // { envelopeId, signerId }, also for an approval
    case "signudoc:declined": // { envelopeId, signerId }, also for a rejection
    case "signudoc:error": // { state }: "expired", "already-signed", "completed", "voided", …
  }
});
```

Treat these messages as a hint for your page, such as closing the frame.
For your records, rely on the [webhooks](#webhooks) or the envelope's
status in the API, which are signed or authenticated.

For a page on your own machine while developing, set
`EMBED_ALLOW_HTTP_ORIGINS=1` to allow `http://` origins; it is ignored on
Vercel.
