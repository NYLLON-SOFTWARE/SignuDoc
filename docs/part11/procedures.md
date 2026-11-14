# Procedures (SOP templates)

Short templates for the procedures Part 11 expects you to have. Put each into your own SOP format and add owners, training needs and review dates. Replace each `[ ]` with your own text.

## SOP-1 Accounts and identity confirmation (11.100, 11.300)

1. Only people who sign or send regulated records get an account. Each account is for one person and is never reassigned or reused, even after the person leaves.
2. Before confirming an identity, the administrator checks it with `[a government photo ID in person / your HR record / …]`.
3. The administrator confirms the identity in Settings, People, Confirm identity. The note says how the check was done and gives a reference, such as "Passport seen in person, HR record 4417". The note must not contain the ID number itself.
4. `[A second administrator reviews new confirmations within N days.]`
5. When a person leaves or changes role, the administrator takes back their identity confirmation the same day, then closes or limits the account.
6. Every `[quarter]`, an administrator reviews every confirmed account against the current staff list, and records the review.

## SOP-2 Passwords (11.300)

1. Passwords are personal. Nobody may share one, write one where others can see it, or sign in for someone else.
2. If a password may be known to someone else, the person changes it at once and tells `[the system owner]`.
3. Lock screens when away from the computer.
4. Change passwords `[every N months / when there is reason]`. SignuDoc does not force password aging (see [Known gaps](known-gaps.md)).

## SOP-3 Sending and signing regulated records

1. The sender chooses the meaning for each signer according to `[the table below]`.

   | Record type | Signer role | Meaning    |
   | ----------- | ----------- | ---------- |
   | `[SOP]`     | `[Author]`  | Authorship |
   | `[SOP]`     | `[QA]`      | Approval   |
   | `[ ]`       | `[ ]`       | `[ ]`      |

2. Signers read the whole document, check the meaning shown in the Finish dialog, and sign only if it is right. If it isn't, they decline and tell the sender.
3. A sent record that must not go ahead is voided with a reason, never left to expire.
4. Signers are trained on this SOP before their first signature, and the training is recorded.

## SOP-4 Signing locks (11.300(d))

1. When the "Signing locked" email arrives, an administrator contacts the person by `[phone / in person]`, not by replying to email.
2. If the person did not make the attempts, treat it as a security incident (SOP-6) and do not unlock until it is resolved.
3. If they did, the administrator unlocks signing in Settings, People and records the reason in `[the lock log]`.

## SOP-5 Audit trail review and records (11.10(c), (e))

1. Every `[month]`, an administrator:
   - opens Settings, Part 11 and confirms the site audit trail chain is intact;
   - downloads the site audit trail CSV for the period and files it in `[location]`;
   - looks for unexpected settings changes, role changes, Part 11 mode changes, identity changes and locks.
2. For each finished regulated record, the sender files the signed PDF, the certificate and the envelope's audit trail CSV in `[the record system]` within `[N]` days.
3. If a chain check ever shows broken, stop using the install for new records and handle it as an incident.
4. Records are kept for `[the period your predicate rules require]`. They are deleted only by hand, under `[procedure]`, after that period, with the deletion recorded.
5. Backups of the database and of the Blob store are taken `[how and how often]` and a restore is tested `[how often]`.

## SOP-6 Incidents

1. Incidents include:
   - suspected misuse of an account;
   - a broken audit chain;
   - a failed restore;
   - an outage that affects regulated records;
   - a security fix from the SignuDoc project.
2. Record the incident, assess its effect on records, act, and close it with a CAPA where needed.
3. A security problem in SignuDoc itself is reported to the project privately through GitHub's private vulnerability reporting, not in a public issue.

## SOP-7 Validation and change control (11.10(a), (k))

1. The install is validated with the [installation](installation-qualification.md) and [operational](operational-qualification.md) qualification before use.
2. Every change follows [Release and change control](change-control.md).
3. This validation pack is kept as a controlled document, with its version and approval.
