# Signing order and approvers

The signing order is a list of steps. Each signer is in one step.

- Signers in **the same step sign at the same time.** They are all invited when the step starts, each with a link of their own, and sign in any order among themselves.
- **The next step starts once every signer of the step before has signed.** Its signers are invited then.
- A list where every signer has a step of their own is the plain one-after-the-other order, which is what every envelope sent before steps existed has.
- A list where every signer is in one step is "any order": everyone is invited when it is sent, and the envelope is finished when the last of them signs, whoever that is.
- **Copy recipients** are not in any step. They get the finished document once everyone has signed, as before.

On the signers page, each signer after the first has **Sign at the same time as Signer N**. Ticked, they join the step of the signer above them. So a salesperson can send a contract to the customer and their manager at the same time, and to the company's signatory once both have signed:

| Signer          | Sign at the same time as the signer above | Step |
| --------------- | ----------------------------------------- | ---- |
| Customer        |                                           | 1    |
| Sales manager   | ticked                                    | 1    |
| Company officer |                                           | 2    |

Ticking it for every signer puts them all in step 1. Removing or moving a signer leaves everyone else in their step. A signer moved past the edge of their step gets one of their own, or joins the step they land in the middle of.

A template keeps each role's step, so roles that signed at the same time still do when the template is used. A template saved before steps existed signs one role after the other.

## What happens along the way

- **Invitations.** Sending invites everyone in the first step. If the first invitation cannot be sent, nothing is sent and the envelope stays a draft. Once one has gone out, the envelope is out for signature; a later one that fails is logged, and a reminder sends that signer a new link.
- **What a signer sees.** A signer sees what the signers of earlier steps filled in. What someone in their own step has filled in is not shown: it was not on the page when their turn began. The finished document has everyone's.
- **Reminders.** The sender's **Send reminder** reminds every signer whose turn it is, each with a new link, leaving out anyone reminded in the last 24 hours. Automatic reminders reach each waiting signer on their own schedule.
- **Deadline.** One deadline for the whole envelope, as before. Changing it moves the links of everyone whose turn it is. The notice that an envelope expired names everyone it was waiting on.
- **Decline.** One signer declining ends the envelope for everyone, including the others in the same step, as before.
- **Void.** Voiding tells everyone whose turn it was.
- **Correcting a signer** works on each waiting signer separately: the corrected person gets a new invitation and the old link stops working.
- **Certificate and audit trail.** The certificate numbers each signer by their step. When some share a step it says that signers with the same number were asked to sign at the same time. The envelope's audit trail records the step of each signature and decline, and the "sent" event names everyone invited at once.

## When two signers submit at the same moment

Every signature takes hold of the envelope's row in the database before it changes anything, and so does every decline, void, reminder and change of deadline. Two signers of one step who submit at the same moment therefore take turns:

- the first one's signature is saved;
- the second one then sees, with the envelope held, whether anyone is still to sign. If someone is, it saves its signature and invites the next step if this one is now done. If nobody is, it starts again as the last signature, and makes the final signed PDF, the certificates and the "completed" event, once.

A decline or a void that finds a signer of the step signed in the meantime starts again too, so its certificate shows that signature. `src/lib/parallel-signing.dbtest.ts` runs these races against a real Postgres.

## Where signing at the same time is not offered

- **Part 11 mode.** Part 11 envelopes are signed one signer after another. The Part 11 validation (requirement SYS-08 and OQ-06) is written for that order, and a different sequence would need your OQ to be run again before use. The signers page does not offer the choice in Part 11 mode, and a send that has signers sharing a step is refused.
- **Advanced and qualified signatures** (eID Easy or a CSC provider). Each such signature is added to the PDF on top of the one before it, so two cannot be made at once. The review page and the send refuse it; choose SignuDoc signatures, or give each signer their own step.

## Approvers

Anyone in the signing order can be an **approver** instead of a signer. On the signers page, each person has **Signs the document** or **Approves or rejects it (no fields)**.

- An approver **reviews the document and approves or rejects it**. They have no fields, place no signature, and nothing of theirs is stamped on the signed PDF. They see what the steps before them filled in, as a signer does.
- Approvers are **in the steps like signers**. The next step starts once every signer and approver of the step before is done. So a salesperson can have their manager approve first, and the customer sign once the manager has:

| Person          | Role     | Step |
| --------------- | -------- | ---- |
| Sales manager   | Approver | 1    |
| Customer        | Signer   | 2    |
| Company officer | Signer   | 3    |

- **Reject** works like decline: it ends the envelope for everyone, with the reason the approver gives, and the sender is emailed "was rejected by".
- An approver goes through the same checks as a signer: the access code or emailed code the sender asked for, and the agreement to use electronic records.
- An envelope needs at least one signer. Approvers cannot have fields: placing fields offers only the signers, and saving a field for an approver is refused (by the app and by the database).
- **Templates** keep whether each role signs or approves.

### What happens along the way

- **Invitations and reminders** ask an approver to "review and approve or reject", not to sign.
- **Deadlines, reminders, void and correcting a person** work for approvers exactly as for signers.
- **Audit trail.** An approval is recorded as **approved** and a rejection as **rejected**, never as signed or declined, with the approver's step and the checks they passed. The envelope's timeline says "Approved by" and "Rejected by".
- **Certificate.** The list is headed "Signers and approvers", each approver is marked **Approver** with "Approved at" or "Rejected at", and a separate **Approvals** section lists "Approved by" (or "Rejected by", with the reason) for each approver. A line says approvers placed no signature.
- **At the same moment.** An approval takes hold of the envelope's row exactly as a signature does, so an approver and a signer of one step who finish at the same moment move the order on, or finish the envelope, once. `src/lib/approvers.dbtest.ts` runs these races.

### Where approvers are not offered

- **Part 11 mode.** An approval is an electronic signature under 21 CFR Part 11 (11.50 lists approval as a meaning), with the account, password and printed manifestation that go with one. Part 11 mode therefore has no approvers: add the person as a signer with the meaning Approval. The signers page does not offer the choice, a send with approvers is refused, and an approval on a Part 11 envelope is refused too.
- **Advanced and qualified signatures.** The finished document is the last signer's own signed revision, and an approval makes none. Send with SignuDoc signatures, or make the approver a signer.

### Upgrading

The migration `20261121110000_approvers.sql` allows the role `approver` and the events `approved` and `rejected`. An approval is stored as the person's turn being done (`signers.status = 'signed'`, with `signed_at` the time of the approval) and a rejection as `declined`, so everything that moves the order on, counts who is still to act or locks a turn treats an approver exactly as a signer; the role and the events tell them apart. An older version of the app reads only role `signer` and would leave approvers out of the signing order, so roll back past this migration only with no approvers on envelopes out for signature.

## How many signers

An envelope can have up to 25 signers. Set `MAX_SIGNERS_PER_ENVELOPE` (1 to 100) to change that. The old limit of ten was not tied to anything technical: the certificate runs onto as many pages as it needs. Templates follow the same limit when they are used.

## Upgrading and rolling back

The migration `20261119090000_signing_steps.sql` adds `signers.signing_step` and gives every existing signer the step of their place in the list, so existing envelopes keep signing one after the other. It drops the index that allowed only one waiting signer per envelope. `sign_order` stays the signer's place in the list and stays unique.

An older version of the app still runs on the migrated database, but it signs an envelope whose signers share a step one after the other, and invites only the first of them when it is sent. Roll back past this migration only with no such envelopes out for signature.

## For developers

- `src/lib/signing-steps.ts`: steps, renumbering, and who is invited next.
- `src/lib/signing.ts`: `submitSigningForToken`, `approveSigningForToken` (the same path, with no fields and an "approved" event) and `declineSigningForToken` (a "rejected" event for an approver), and the restart when the route changed (`SigningRouteChangedError`).
- `src/lib/signer-limit.ts`: the install's limit on signers.
- Tests: `signing-steps.test.ts`, `parallel-signing.dbtest.ts` and `approvers.dbtest.ts`.
