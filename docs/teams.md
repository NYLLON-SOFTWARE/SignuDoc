# Teams

How people on a team see each other's envelopes.

- [Making teams](#making-teams)
- [Who can do what](#who-can-do-what)
- [Upgrading and rolling back](#upgrading-and-rolling-back)
- [For developers](#for-developers)

## Making teams

An administrator makes teams in **Settings**, under **Teams**, and adds people who have an account by their email address. Someone can be on several teams.

People on a team see the unfiled envelopes sent by the others on any of their teams. Filed envelopes follow their [folder permissions](agreement-folders.md). The dashboard has **Mine** and **My team**, and an administrator also has **Everyone's**. **My team** lists your own envelopes and your teammates' sent ones, a page at a time like the other views, and its search box also finds a teammate by name or email. A teammate's envelope says who sent it.

Making, renaming and deleting a team, and adding and removing people, are recorded in the install's audit trail (Settings, Organization, "Site audit trail") as "Team made", "Team changed", "Team deleted", "Added to a team" and "Removed from a team". Deleting a team leaves everyone's envelopes as they are; its members just stop seeing each other's.

## Who can do what

|                                                                                      | The sender | Someone on a team with the sender | An administrator | Anyone else |
| ------------------------------------------------------------------------------------ | ---------- | --------------------------------- | ---------------- | ----------- |
| See a draft                                                                          | yes        | no                                | no               | no          |
| See a sent envelope: its signers, status and timeline                                | yes        | yes                               | yes              | no          |
| Open the document as it was sent (View document)                                     | yes        | yes                               | yes              | no          |
| Export its audit trail                                                               | yes        | yes                               | yes              | no          |
| Download the signed PDF and certificate once finished                                | yes        | yes                               | yes              | no          |
| Edit a draft, send, remind, change the deadline or reminders, correct a signer, void | yes        | no                                | no               | no          |
| Copy to a new draft, save as a template                                              | yes        | no                                | no               | no          |
| Schedule a finished envelope for deletion (14 days), or cancel that                  | if admin   | no                                | yes              | no          |

Opening or downloading someone else's file, by an administrator or by a teammate, is recorded in the site audit trail as "Another member's file downloaded". An envelope handed to an administrator when its sender's account was closed is that administrator's, so the closed account's teammates see it only if they are on a team with that administrator.

Envelope pages and downloads that are not someone's to see answer "not found", the same as for an envelope that does not exist.

## Upgrading and rolling back

The migration `20261121100000_teams.sql` adds the tables `teams` and `team_members`. Nothing else changes, and nobody sees anything new until an administrator makes a team. An older version of the app runs on the migrated database and ignores the teams.

## For developers

- `src/lib/envelope-access.ts`: the one rule for who can read an envelope, `resolveEnvelopeViewerAccess`. Everything that changes an envelope still checks `user_id` itself.
- `src/lib/envelopes.ts`: `listTeamEnvelopesForUser`, the **My team** list.
- `src/lib/teams.ts` and `src/app/api/admin/teams/`: teams and their audit events.
- `src/lib/team-access.dbtest.ts` goes through the table above against a real Postgres (`npm run test:db`).
