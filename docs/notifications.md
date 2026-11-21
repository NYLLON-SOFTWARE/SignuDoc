# Notifications

SignuDoc can tell people in Slack when something happens to an envelope. Nothing is sent until an administrator sets Slack up, and email works as before whatever is set here.

## What is announced

| Event              | When                                                                | Direct message by default |
| ------------------ | ------------------------------------------------------------------- | ------------------------- |
| Sent               | An envelope was sent for signature.                                 | No                        |
| Opened             | A signer opened it for the first time.                              | No                        |
| Signed             | A signer signed (one message per signer).                           | Yes                       |
| Completed          | Everyone has signed and the signed PDF is ready.                    | Yes                       |
| Declined           | A signer declined.                                                  | Yes                       |
| Voided             | The sender withdrew it.                                             | No                        |
| Expired            | The deadline passed before everyone signed.                         | Yes                       |
| Deadline coming up | The deadline is a few days away (3 by default).                     | Yes                       |
| No activity        | Nobody has opened or signed it for a number of days (7 by default). | Yes                       |

Every message has the same layout. Your organization's name (and logo, when the site is on https and has one) is at the top. Below it, a coloured bar: blue for progress, green when done, amber for a warning, red when something went wrong, grey for a voided envelope. Then one line in plain words, such as "Alex Chen signed **Acme MSA** — 2 of 3 signed", where the envelope stands (status, the sender, the deadline, when it happened), and buttons:

- **Open envelope** on every envelope message.
- **View certificate** when an envelope is completed. It goes through a page of the app, so someone who is signed out is asked to sign in first.
- **Send reminder** on "Deadline coming up" and "No activity", in the sender's own direct message. It opens the envelope, where the reminder is sent.

The buttons are plain links. A message never carries the document, a field's value or a reason someone gave for declining: whoever can read the channel is sent to SignuDoc, which checks who they are, for anything more. Settings, Notifications shows a preview of each kind of message, with your organization's name and logo.

### One message per envelope

- **In a channel**, the first post about an envelope starts a thread. Later events reply in that thread, and the first post is edited to show where the envelope stands now. So a channel has one message per envelope, always up to date.
- **In a direct message**, progress (sent, opened, signed, voided) edits one message per envelope, such as "2 of 3 signed". Slack does not notify for an edit. A new message arrives only when something needs the sender: completed, declined, expired, a deadline coming up, or no activity. That also brings the progress message up to date.

If someone deletes the first post or the progress message, the next event posts a new one.

### Fewer messages

- **Bursts.** A signature or an opening waits a minute before it is sent. If another event about the same envelope comes for the same place in that minute, only the newest is sent, since every message shows the envelope as it is now. Three people signing in a row make one message, not three. Completed, declined and the other outcomes do not wait.
- **Your own actions.** Nobody gets a direct message about something they did themselves: a sender who signs their own envelope is not told they signed it. Channels still hear about it, and outcomes such as "completed" still reach everyone.

"Deadline coming up" and "Expired" are sent once per deadline (moving the deadline and coming close again, or letting it pass again, sends it again), and "No activity" once per envelope still open for signing. "Expired" comes from the scheduled run, for deadlines passed in the last week, whether or not the email telling the sender went out. Activity is anything in the envelope's audit trail except the emails and reminders SignuDoc itself sent. Only envelopes sent in the last 90 days are checked for activity, so turning notifications on does not announce every forgotten envelope.

## Who gets what

- **The sender** of an envelope gets a direct message for the events marked "Yes" above. Each person changes that for themselves under Settings, My notifications.
- **Channels** get what a rule sends them. A rule names the events and one Slack channel. A draft is never announced in a channel.

Pausing, changing or deleting a rule, or turning an event off, also stops the messages already waiting to go (a signature waiting out its minute, or a send waiting to be tried again).

Slack finds a person by the email address of their account here (`users.lookupByEmail`), so their Slack account needs the same address. A person Slack cannot find is skipped, which the setup page counts. When someone's address changes, they are looked up again, and the Slack account it finds gets messages of its own: nothing more is posted or edited in the old account's direct messages.

## Set up Slack

Under Settings, Notifications (administrators only):

1. **Create the app.** Open [api.slack.com/apps](https://api.slack.com/apps?new_app=1), choose From a manifest, pick your workspace, and paste the manifest the page shows. It is filled in with your organization's name (or SignuDoc), a description, this site's address, and your brand colour when white text reads well on it. Slack does not take an icon in a manifest, so the page has a "Download app icon (512×512)" link: your logo, or SignuDoc's mark when there is none. In Slack, open your app's Basic Information page, then Display Information, and upload it.
2. **Install it and paste the token.** Under Install App, install it to your workspace and copy the Bot User OAuth Token (`xoxb-...`) into the page. It is stored encrypted and never shown again (see [Where the token is kept](#where-the-token-is-kept)). `SLACK_BOT_TOKEN`, when set, wins and the page shows the token as fixed.
3. **Test the connection.** The page asks Slack (`auth.test`) which workspace the token belongs to.
4. **Direct messages** are on once the token is saved. Turn them off to only post to channels. "Send me a test message" checks that Slack finds you.
5. **Invite the app to each channel** that should get posts (`/invite @AppName` in the channel), then add a rule for it. The page lists public channels to pick from; for a private channel, invite the app and paste the channel's ID from its details. Each rule has a "Send test" button that posts a sample of its first event to the channel and says what Slack answered.

### Why these scopes

The manifest asks for four bot scopes and nothing else:

| Scope              | Why                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat:write`       | Post the messages, to people and to channels the app was invited to. Without `chat:write.public` it cannot post anywhere it was not invited. |
| `users:read`       | Needed with `users:read.email`; Slack does not grant one without the other.                                                                  |
| `users:read.email` | Find a person by their email address, for direct messages.                                                                                   |
| `channels:read`    | List public channels to pick from when making a rule. Private channels are pasted by ID instead, so `groups:read` is not needed.             |

The app has no event subscriptions, slash commands or interactivity, and cannot read messages. The buttons in a message are plain links. `chat:write` also lets it edit its own messages, which is how a thread's first post and a progress message stay up to date.

### Where the token is kept

A token pasted in Settings is kept in the `notification_settings` table, encrypted (AES-256-GCM) with a key derived from the auth secret, the same way as the seal's own private key. It is never sent back to the browser or written to the audit trail. If the auth secret changes (`BETTER_AUTH_SECRET`, or the database password it is derived from when that is unset), the stored token can no longer be read and Slack counts as not set up until the token is pasted again.

A new or removed token also forgets the Slack accounts and messages remembered for the old one, since they belong to the workspace that token was for. So does a change of `SLACK_BOT_TOKEN`: the next run sees that the token is another (from a hash of it, kept in `notification_channel_accounts`) and forgets them.

## How delivery works

1. Every envelope audit event is queued in `notification_events` by a database trigger, in the audit event's own transaction. So an event that is recorded is never missed, and one that is rolled back is never announced. The notifications job queues its own events (deadlines coming up, idle envelopes) the same way, each under a key that makes it happen once.
2. Right after a request that recorded an audit event, the app turns queued events into deliveries (`notification_deliveries`, one per person or channel, unique, so never two to the same place) and sends them. On Vercel this runs in `after()`, once the response has gone. A signature waits a minute (see Fewer messages), so that run waits for it, up to three times, rather than leave it for the next scheduled run. That wait counts towards the request's time limit, so a route that sets its own `maxDuration` leaves room for it (the signing provider's return allows 180 seconds).
3. A failed send is tried again 1, 2, 4... minutes later, up to six hours apart, eight times in all. When Slack asks to slow down (HTTP 429), the message waits its `Retry-After`, and nothing more goes to Slack until it is over, from any run: the pause is kept in `notification_channel_pauses`. That does not count as a try. A channel that does not exist, or that the app was never invited to, fails at once. Only Slack's HTTP status and error code are kept, never what else it sent back.
4. Before a delivery posts or edits an envelope's message in a place, it takes a short lease on that message (`notification_threads`). So two runs never both start a thread for the same envelope. A delivery that finds the lease taken waits five seconds, which does not count as a try. A delivery left behind by a burst is marked skipped as "superseded"; the page counts those as combined into a later message. A deadline or idle warning that no longer applies by the time it would go out (the envelope was finished, its deadline moved, or someone did something with it) is marked skipped as "outdated".
5. `/api/internal/notifications` runs the whole job: it notices deadlines coming up and idle envelopes, and sends whatever is due, retries included. See [Notifications](self-hosting.md#notifications) in the self-hosting guide for scheduling it.

Delivery is at least once: a run cut off between Slack taking a message and the app noting it sends that message again later. Events older than three days that were never processed (notifications switched off, say) are dropped rather than announced late. Processed events are deleted after 30 days by the scheduled run, Slack set up or not, and a thread nobody has touched for 90 days is forgotten.

## Settings and environment variables

| Setting                | In Settings, Notifications              | Environment variable (wins)  |
| ---------------------- | --------------------------------------- | ---------------------------- |
| Slack bot token        | Bot User OAuth Token                    | `SLACK_BOT_TOKEN`            |
| Direct messages        | Send direct messages                    | none                         |
| Deadline warning, days | Days before a deadline (0 turns it off) | `NOTIFICATION_EXPIRING_DAYS` |
| Idle warning, days     | Days without activity (0 turns it off)  | `NOTIFICATION_STUCK_DAYS`    |

Every change of these settings and of the rules is recorded in the install's audit trail.

## Adding a channel

A chat tool is one folder under `src/lib/notifications/` (Slack's is `slack/`) exporting a `NotificationChannelPackage` (`src/lib/notifications/channel.ts`), plus one entry in `registry.ts`. The rest of the library and the API routes reach it only through the registry, by its id. The package says:

- **Sending:** whether it is set up, how it finds a person by email, which destinations a rule may name (`destinationSchema`), and how it sends a message. `send` is told where the message goes (a thread in a channel, one message edited in place, or a new message) and the message to edit or reply to, and returns the message to remember; a tool without threads or edits can post a new message every time and return none.
- **Setup** (`setup`): the credential's check, what to paste into the tool to create the app, its icon, plain words for its error codes, and the setup page's checks (test the connection, list the places to post to, send a test message).
- **Previews** (`previews`): a sample of each kind of message as the tool shows it.

The outbox, the rules and everyone's choices already work for any channel by its id. The setup page still needs a section that draws the tool's own steps and previews.

## Adding an event

Add the kind to `notificationEventKinds` and `NOTIFICATION_EVENTS` in `src/lib/notifications/events.ts`, with the audit event it comes from, its headline and tone in `message.ts`, and its emoji in `slack/layout.ts`. Say in `events.ts` whether it edits the progress message (`IN_PLACE_KINDS`) and whether it waits for a burst (`BURST_KINDS`). A new kind of envelope audit event is already queued by the trigger; no migration is needed. The pages, the rules and the choices list whatever is in `events.ts`.
