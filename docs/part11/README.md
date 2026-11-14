# FDA 21 CFR Part 11 validation pack

These are starting documents for an organization that wants to use SignuDoc for records that fall under FDA 21 CFR Part 11. Copy them into your own quality system, fill in the blanks marked `[like this]`, and change anything that doesn't match how you work.

> **This is not legal or regulatory advice.** SignuDoc's maintainers do not validate your install, and nothing here says that an install meets Part 11. Whether yours does depends on how you validate it, run it, and control it. Ask your quality and regulatory people, and a lawyer when it matters.

## What SignuDoc does and what you do

SignuDoc provides the software controls in **Part 11 mode**, which an administrator turns on under Settings. The rest is yours.

| SignuDoc (software)                                                                               | Your organization                                                                                           |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Signers sign with their own account. An administrator records how they checked who the person is. | Decide who may sign, check identities, and keep the evidence (11.100(b)).                                   |
| Email and password to open the document, and again at each signature.                             | Make sure people keep their passwords to themselves, and train them (11.10(i), 11.300).                     |
| Five wrong passwords lock signing and email the administrators.                                   | Look into every lock before unlocking (11.300(d)).                                                          |
| The meaning (approval, review, responsibility, authorship) is printed with the name and UTC time. | Choose which meaning each kind of record needs.                                                             |
| Hash-chained audit trails for each envelope and for the install, exportable as CSV.               | Review them, keep the exports, and say who may see them (11.10(d), (e)).                                    |
| Finished Part 11 records are never deleted on a timer or by a data request.                       | Decide how long to keep them, and delete them by hand when your rules allow.                                |
| Sealed PDF and certificate, so any later change to the file shows.                                | Validate the install (11.10(a)), control changes, and send the certification letter to the FDA (11.100(c)). |

## The documents

| Document                                                    | What it is for                                                                                |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [Requirements](requirements.md)                             | What the system has to do, one numbered requirement per line, each tied to a Part 11 section. |
| [Traceability matrix](traceability-matrix.md)               | Each requirement, where SignuDoc meets it, and the test that shows it.                        |
| [Risk assessment](risk-assessment.md)                       | What can go wrong, how bad it would be, and what controls it.                                 |
| [Installation qualification](installation-qualification.md) | A checklist for each new deployment.                                                          |
| [Operational qualification](operational-qualification.md)   | Test scripts a person runs on your install, with places to record results.                    |
| [Release and change control](change-control.md)             | How to take a new SignuDoc version, and the evidence each release gives you.                  |
| [Suppliers](suppliers.md)                                   | Vercel, Neon and Resend: what each one holds, and what to get from each.                      |
| [Procedures (SOP templates)](procedures.md)                 | Accounts and identity checks, signing, audit review, locks, records, incidents.               |
| [FDA certification letter](fda-certification-letter.md)     | A template for the letter 11.100(c) asks for.                                                 |
| [Known gaps](known-gaps.md)                                 | What Part 11 mode does not do yet, and what to do instead.                                    |

## Suggested order

1. Read [Known gaps](known-gaps.md) and [Risk assessment](risk-assessment.md), and decide whether SignuDoc fits your records.
2. Adopt the [procedures](procedures.md) and the [requirements](requirements.md), changed to suit you.
3. Deploy, then run the [installation qualification](installation-qualification.md).
4. Turn on Part 11 mode and run the [operational qualification](operational-qualification.md).
5. Approve the install for use and file the evidence.
6. Send the [certification letter](fda-certification-letter.md) if you haven't already.
7. For every new version, follow [release and change control](change-control.md).
