# Requirements

Your user and functional requirements for SignuDoc in Part 11 mode. Each requirement has an ID that the [traceability matrix](traceability-matrix.md) and the [operational qualification](operational-qualification.md) use. Remove any you don't need, and add your own with new IDs.

Document `[ID]`, version `[1.0]`, approved by `[name, role, date]`.

## System and records

| ID     | Requirement                                                                                                                                                                                                      | Part 11         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| SYS-01 | The system makes accurate and complete copies of records, both readable (PDF) and machine-readable (CSV audit trail).                                                                                            | 11.10(b)        |
| SYS-02 | Records stay retrievable for the whole retention period. They are not deleted by a timer or by a signer's data request.                                                                                          | 11.10(c)        |
| SYS-03 | Only people with an account can reach the system's records. Only administrators can change settings or roles.                                                                                                    | 11.10(d), (g)   |
| SYS-04 | A computer-generated, time-stamped audit trail records the creation, sending, viewing, signing, declining, voiding and completion of each record. It also records who did each step, from where, and when (UTC). | 11.10(e)        |
| SYS-05 | Changes to settings, roles, identity confirmations and signing locks are recorded with the old and new value, who made the change, and when.                                                                     | 11.10(e)        |
| SYS-06 | Audit trail entries cannot be changed without detection: each entry is chained by hash to the one before it, and the system can check the chain.                                                                 | 11.10(e)        |
| SYS-07 | Voiding a sent record needs a reason, and the reason is recorded.                                                                                                                                                | 11.10(e)        |
| SYS-08 | Signers sign in the order the sender set.                                                                                                                                                                        | 11.10(f)        |
| SYS-09 | A finished record is sealed so that any change to the file after signing is detectable.                                                                                                                          | 11.10(c), 11.70 |
| SYS-10 | Turning Part 11 mode off does not change the rules a record was sent under.                                                                                                                                      | 11.10(f)        |

## Signers and signatures

| ID     | Requirement                                                                                                                                              | Part 11        |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| SIG-01 | Each signer signs with their own account, which belongs to one person and is not reused.                                                                 | 11.100(a)      |
| SIG-02 | A record is not sent unless an administrator has confirmed each signer's identity and recorded how.                                                      | 11.100(b)      |
| SIG-03 | A signer whose identity confirmation is taken back, or whose email is no longer confirmed, cannot sign.                                                  | 11.100(b)      |
| SIG-04 | The signer gives two components, email address and password, to open the record and again at each signature.                                             | 11.200(a)(1)   |
| SIG-05 | Each signature shows the signer's printed name, the date and time (UTC), and its meaning. The same information appears in the certificate.               | 11.50(a), (b)  |
| SIG-06 | The signer confirms the meaning of their signature before signing.                                                                                       | 11.50(a)(3)    |
| SIG-07 | The signature is linked to its record, and the seal makes it impossible to copy onto another record undetected.                                          | 11.70          |
| SIG-08 | Passwords are at least 15 characters long and are checked against known breached passwords.                                                              | 11.300(a), (b) |
| SIG-09 | After five wrong passwords in a row while signing, the account can no longer sign until an administrator unlocks it, and every administrator is emailed. | 11.300(d)      |

## Procedural requirements (met by your procedures, not by the software)

| ID     | Requirement                                                                                                                  | Part 11        |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- | -------------- |
| PRO-01 | The install is validated before use and after each change.                                                                   | 11.10(a)       |
| PRO-02 | The people who build, run and use the system are trained and their training is recorded.                                     | 11.10(i)       |
| PRO-03 | People are held accountable for actions under their signatures, by written policy.                                           | 11.10(j)       |
| PRO-04 | System documentation is controlled.                                                                                          | 11.10(k)       |
| PRO-05 | The organization certifies to the FDA that its electronic signatures are the legally binding equivalent of handwritten ones. | 11.100(c)      |
| PRO-06 | Passwords are not shared. Lost or compromised accounts are handled by a written procedure.                                   | 11.300(b), (c) |
| PRO-07 | Audit trails and records are kept for at least as long as the underlying records must be kept.                               | 11.10(e)       |
