# Operational qualification (OQ)

Test scripts for a person to run on your install after the [installation qualification](installation-qualification.md), and again for the areas a new version changes. Each script names the requirements it tests. For each step, record the actual result, Pass or Fail, your initials and the date, and keep screenshots or exports as evidence. A failed step gets a deviation record before you go on.

You need:

- an **administrator** account (Admin);
- a **sender** account (Sender), which can be the administrator;
- two **signer** accounts, Signer A and Signer B, on email addresses you can read;
- a test PDF.

Use test documents only, and mark them as such.

## OQ-01 Accounts and passwords (SYS-03, SIG-08)

| Step | Action                                                                                                                        | Expected                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 1    | Sign up as Signer A with a 14-character password.                                                                             | Refused: too short.                          |
| 2    | Sign up with a password of 15 or more characters that appears in public breach lists (check one on haveibeenpwned.com first). | Refused.                                     |
| 3    | Sign up with a strong password of 15 or more characters, and confirm the email.                                               | Account created, and you can log in.         |
| 4    | As Signer A, open `/settings`.                                                                                                | No Organization, People or Part 11 sections. |
| 5    | Create Signer B the same way.                                                                                                 | Account created.                             |

## OQ-02 Identity confirmation (SIG-02, SYS-05)

| Step | Action                                                                  | Expected                                                                                             |
| ---- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1    | As Admin, in Settings, People, find Signer A.                           | "Identity not confirmed" shown, with a Confirm identity button.                                      |
| 2    | Click Confirm identity and try to save without a note.                  | Save is not possible.                                                                                |
| 3    | Enter how you checked (for example "badge checked in person") and save. | "Identity confirmed". The site audit trail shows "Identity confirmed", with the note and your email. |

## OQ-03 Sending is refused for an unconfirmed signer (SIG-01, SIG-02)

| Step | Action                                                                              | Expected                                                                                      |
| ---- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1    | As Sender, create an envelope with Signer A and Signer B in that order.             | The signers step asks for a meaning for each signer. Next stays disabled until both have one. |
| 2    | Choose Approval for A and Review for B, place a signature field for each, and send. | Refused: an administrator has to confirm Signer B's identity.                                 |
| 3    | Add someone with no account as a signer and send.                                   | Refused: they need an account. Then remove them.                                              |
| 4    | As Admin, confirm Signer B's identity. As Sender, send again.                       | Sent. The envelope's audit trail shows "sent".                                                |

## OQ-04 Signing with email, password and meaning (SIG-04, SIG-06)

| Step | Action                                                                    | Expected                                                     |
| ---- | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1    | As Signer A, open the invitation link.                                    | "Confirm it's you" asks for email address and password.      |
| 2    | Enter the wrong password.                                                 | Refused, with the number of tries left.                      |
| 3    | Enter the right email and password.                                       | The document opens (after the electronic records agreement). |
| 4    | Sign the field and click Finish.                                          | The dialog shows "Approval: …". Finish signing is disabled.  |
| 5    | Tick the meaning box and enter Signer B's email with Signer A's password. | Refused.                                                     |
| 6    | Enter Signer A's own email and password.                                  | Signed.                                                      |

## OQ-05 Lock, alert, unlock and taking back identity (SIG-03, SIG-09)

| Step | Action                                                                                                 | Expected                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | As Signer B, open the link and enter a wrong password five times.                                      | The fifth try says the account is locked for signing.                                                                                   |
| 2    | Check every administrator's inbox.                                                                     | An email "Signing locked for [Signer B]".                                                                                               |
| 3    | Enter the right password.                                                                              | Still refused: locked.                                                                                                                  |
| 4    | As Admin, in People, check Signer B.                                                                   | "Signing locked" and an Unlock signing button. The site audit trail shows four "Wrong password while signing" and one "Signing locked". |
| 5    | Click Unlock signing.                                                                                  | Lock removed, and "Signing unlocked" recorded.                                                                                          |
| 6    | Take back Signer B's identity confirmation. As Signer B, try to open the link with the right password. | Refused: an administrator has to confirm your identity.                                                                                 |
| 7    | Confirm Signer B's identity again.                                                                     | Signer B can open and sign.                                                                                                             |

## OQ-06 Signing order (SYS-08)

| Step | Action                                                       | Expected             |
| ---- | ------------------------------------------------------------ | -------------------- |
| 1    | Before Signer A has signed in OQ-04, check Signer B's inbox. | No invitation yet.   |
| 2    | After Signer A signs.                                        | Signer B is invited. |

## OQ-07 Signed record and manifestation (SIG-05, SIG-07, SYS-09)

| Step | Action                                                                      | Expected                                                                                                                                                |
| ---- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | After both have signed, download the signed PDF.                            | Below each signature: "Signed by [name] \| [YYYY-MM-DD HH:MM:SS] UTC \| Meaning: [meaning]".                                                            |
| 2    | Download the certificate.                                                   | For each signer: identified by their own account, with email and password given again to sign; the manifestation line; the confirmed meaning statement. |
| 3    | Upload the signed PDF on `/verify`.                                         | It matches.                                                                                                                                             |
| 4    | Change one byte of the PDF (for example, edit it and save), then upload it. | No match.                                                                                                                                               |

## OQ-08 Envelope audit trail and export (SYS-01, SYS-04)

| Step | Action                                                     | Expected                                                                                                                                                                                                                           |
| ---- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | As Sender, open the envelope and click Export audit trail. | A CSV downloads, opening with "Part 11 envelope, yes" and "Hash chain check, intact".                                                                                                                                              |
| 2    | Read the rows.                                             | `sent`, `viewed`, `verified`, `verification_failed`, `consented`, `reauthentication_failed`, `signed` and `completed` events, each with time (UTC), actor, IP address and browser. The `signed` row's details include the meaning. |

## OQ-09 Install audit trail (SYS-05, SYS-06)

| Step | Action                                                         | Expected                                                                          |
| ---- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1    | As Admin, change the organization name and save.               | The site audit trail shows "Settings changed: organizationName".                  |
| 2    | Make Signer A an administrator, then make them a member again. | Two "Role changed" entries.                                                       |
| 3    | Click Download as CSV.                                         | The CSV opens with "Hash chain check (whole trail), intact" and lists the events. |

## OQ-10 Records are kept (SYS-02)

| Step | Action                                                                           | Expected                                                                   |
| ---- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1    | As Admin, try to set a retention period.                                         | The field is disabled while Part 11 mode is on.                            |
| 2    | In Settings, Signer data, erase Signer A's data (confirm by typing the address). | The Part 11 record is reported as kept, and it still opens for the Sender. |

## OQ-11 Void needs a reason (SYS-07)

| Step | Action                                        | Expected                                                             |
| ---- | --------------------------------------------- | -------------------------------------------------------------------- |
| 1    | Send a new Part 11 envelope, then click Void. | The confirm button stays disabled until a reason is typed.           |
| 2    | Type a reason and void.                       | The envelope's history shows the reason, and so does the CSV export. |

## OQ-12 Turning the mode off (SYS-10)

| Step | Action                                                           | Expected                                                               |
| ---- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1    | Send a Part 11 envelope to Signer A, then turn Part 11 mode off. | "Part 11 mode changed: Turned off" recorded.                           |
| 2    | As Signer A, open the envelope.                                  | Email and password are still required, and the meaning is still shown. |
| 3    | Turn Part 11 mode on again for production use.                   | Recorded.                                                              |

Executed by `[name]`, reviewed by `[name]`, approved by `[name, role, date]`.
