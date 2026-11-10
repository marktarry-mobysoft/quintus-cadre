# Notification backing: vendor or in-house?

Research for [#13](https://github.com/marktarry-mobysoft/quintus-cadre/issues/13), a child of the map [#11](https://github.com/marktarry-mobysoft/quintus-cadre/issues/11). Sources were read on 2026-11-10. Vendor pricing and plan limits change often, so check them again before signing up.

## Recommendation

**Build it in-house:** a `notifications` table in the existing SQLite database through Drizzle, behind a small `NotificationStore` interface, with email handed to the existing `sendEmail`.

The reasoning:

1. **The hard constraints cost a vendor the most.** Every vendor would need a thin local adapter anyway, because none has a credential-free local mode (see "Local fallback" below). So the in-house store has to exist even if we buy a vendor. That makes the in-house version the cheapest place to start, and building it is not wasted work.
2. **A vendor's main selling points are things we have ruled out.** Vendors sell drop-in UI widgets (ruled out), many channels (push is out of scope, and only email is needed), and visual workflow builders. What we would actually use is a feed table, a read flag and an email call, which is a day's work in Drizzle.
3. **Email stays exactly as it is.** The in-house store calls `sendEmail` (Postmark, or `.outbox/` locally) directly. A vendor would need Postmark credentials configured on its side (Knock, Courier) or would not support Postmark at all (MagicBell).
4. **Polling or refreshing on navigation is enough for v1** (map Notes). A React Router loader that reads the unread count covers it. A vendor's websocket is a nice-to-have we don't need.
5. **Low lock-in in both directions.** If we put the store behind an interface shaped like `MailTransport` (`notify`, `listFeed`, `unreadCount`, `markRead`, `markAllRead`), we can add a Knock adapter later without touching any route.

**Main weakness: scheduling.** The in-house option has no scheduler, and Cadence has no job runner. If time-based nudges survive the event catalogue, they need a separate decision (see the map's "Scheduled work"). The cheapest in-house shape is a `send_after` column plus a sweep that runs on an interval inside the Node server process, or one triggered from an existing request. If that turns out to be too fragile, **Knock** is the vendor to add. It has the strongest delay/schedule support (up to 365 days, set dynamically from trigger data), a Postmark email integration, a webhook channel, and a free tier of 10,000 messages a month. Its downside is the jump to $250/month on the first paid tier.

## Comparison

| Constraint | In-house (SQLite + Drizzle + polling) | Knock | Novu (Cloud) | Courier | MagicBell |
| --- | --- | --- | --- | --- | --- |
| **API-only / headless**: feed, unread count, mark-read without vendor UI | Yes. We own the queries. | Yes. Feed API returns items plus `unread_count`/`unseen_count` metadata. Per-message and batch read/seen/archive endpoints exist. "Mark all read" over the API means listing IDs and then calling the batch endpoint. [1][2] | Yes, through the `@novu/js` client: `notifications.list`, `notifications.count({ read: false })`, and `read`/`archive`. The headless mode is built around client-side hooks. [9][10] | Yes, through the Courier JS SDK (`getMessages`, unread counts, `read`, `readAll`) using a JWT that your backend issues. I could not find a documented public REST path for the raw inbox. [14] | Yes. REST endpoints fetch a user's notifications, mark one read or unread, and mark all read or seen. There is also a headless React SDK. [18][19] |
| **Email channel** | Calls the existing `sendEmail` directly. Nothing changes. | Sends email only through a connected provider. **Postmark is supported.** It also has a webhook channel that could POST to our own endpoint, which would then call `sendEmail`. [3][4] | Sends email through connected providers (Postmark is in Novu's provider catalogue). Not verified in depth. | Sends email through providers. **Postmark is supported** (server token plus From address). [15] | Supports SES, Mailgun, SendGrid, Ping Email and SMTP. **Postmark is not listed**, though Postmark's SMTP endpoint would probably work through the SMTP channel. [20][21] |
| **Local fallback**: dev and tests with no credentials | Native. The same SQLite file is used, and email goes to `.outbox/`. | No local mode. It has test environments and email "sandbox mode", but both need an account and a key. [3] We'd need our own adapter. | Self-hosting needs Docker with MongoDB, Redis and workers, which is far too heavy for `npm run test`. [12] We'd need our own adapter. | No local mode found. We'd need our own adapter. | No local mode found. We'd need our own adapter. |
| **Server fit**: Node SDK, triggering, preferences | Plain functions called from actions, in the same transaction as the comment insert. We'd have to build preferences ourselves (one table). | `@knocklabs/node`. You trigger workflows by key with a data payload. Channel, workflow and category preferences are on every plan. [5] | `@novu/api` and the framework SDK. Workflows are triggered by ID. Preferences are supported. Free tier caps you at 5 workflows. [6] | Node SDK. Sends go through templates, routing, and Journeys/Automations. Preferences are supported. [7] | Node client (`magicbell-js`). Workflows are listed as a product, but the docs give few details. [20] |
| **Scheduling**: delayed or scheduled sends | **Not provided.** Needs a `send_after` column plus a sweep, and Cadence has no job runner. | Yes. Delay step (fixed, dynamic from trigger data, relative, or a time window), up to 365 days. One-time and recurring schedules via `scheduled_at`. Runs can be cancelled. [8] | Yes. Delay step (fixed, scheduled, or dynamic). The maximum delay depends on plan: **Free 1 day**, Pro 7 days, Team 30 days. [11] | Yes. Automation delay by `duration` or `until` (ISO 8601). Journeys delay node with conditions. [16][17] | Not documented on the pages I read. |
| **Live updates** (nice-to-have) | Polling, or revalidating on navigation. Enough for v1. | WebSocket `new-message` event with badge counts. [1] | Realtime events (`notifications.notification_received`, `unread_count_changed`). [10] | Realtime is built into the SDK. | Realtime inbox updates. [19] |
| **Cost at small scale** | $0, apart from our own time. | Free up to 10,000 messages/month (not hard-capped). Starter is **$250/month** for 50,000 messages, then $0.005 each. [13] | Free up to 10,000 workflow runs/month and 5 workflows, with 24-hour activity retention. Pro is **$30/month** for 30,000 runs. [6] | Free up to 10,000 sends/month. Business is **$0.005 per send**, pay-as-you-go. [7] | Free up to 1,000 deliveries/month. Startup is **$249/month** for 50,000. [22] |
| **Lock-in / switching cost** | Lowest. The data is in our own database, and the interface lets us add a vendor later. | Medium. Workflows, templates and preferences live in Knock. If templates stay thin (we render in-app UI ourselves), migrating is mostly a change to trigger calls. | Medium. The core is open source under MIT (open-core; some features are Enterprise-only), so self-hosting is an exit path, but a heavy one. [12][23] | Medium to high. Journeys and templates live in Courier. | Medium. |

### Constraint no candidate fully meets

- **Local fallback with no credentials.** No vendor offers a lightweight local or offline mode. Novu's self-hosted Docker stack (MongoDB, Redis and workers) is the closest thing, and it is too heavy for `npm run dev` and `npm run test`. Every vendor option therefore needs a thin in-house adapter as its fallback, which is part of why the recommendation is to start in-house.
- **Scheduling, for the in-house option.** The in-house store meets every constraint except scheduled sends. Every vendor except MagicBell (where it is undocumented) provides delays. On Novu's Free plan, delays are capped at 1 day.
- **Postmark email with MagicBell.** MagicBell has no Postmark integration. It could only use Postmark through generic SMTP, which I have not verified.

## Proposed in-house shape (for the PRD)

- A `notifications` table: `id`, `recipientUserId`, `type`, `actorUserId`, `subjectType`/`subjectId` (for example, a comment), `createdAt`, `readAt` (null means unread), and an optional `sendAfter` if scheduling survives. Index it on `(recipientUserId, readAt)`.
- A `notification_preferences` table keyed by user and notification type, with in-app and email flags.
- `app/lib/notifications.server.ts`, following the pattern in `mailer.server.ts`: a `NotificationStore` interface, a Drizzle implementation, and a `notify()` that writes the row and calls `sendEmail` when the preference allows.
- The unread count is read in the root loader. React Router revalidates it on navigation, and a light `useRevalidator` poll can be added if wanted.

## Sources

1. Knock, In-app UI API overview: https://docs.knock.app/in-app-ui/api-overview
2. Knock, Messages API reference (read/seen/archive, batch endpoints): https://docs.knock.app/api-reference/messages
3. Knock, Email integrations overview (providers, Postmark, sandbox mode): https://docs.knock.app/integrations/email/overview
4. Knock, Webhook channel: https://docs.knock.app/integrations/webhook/overview
5. Knock, Pricing (preferences, scheduled workflows, batching on all plans): https://knock.app/pricing
6. Novu, Pricing: https://novu.co/pricing
7. Courier, Pricing: https://www.courier.com/pricing
8. Knock, Delay function: https://docs.knock.app/designing-workflows/delay-function
9. Novu, `@novu/js` API reference: https://docs.novu.co/platform/sdks/javascript
10. Novu, Inbox headless mode: https://docs.novu.co/platform/inbox/headless-mode
11. Novu, Delay step: https://docs.novu.co/platform/workflow/add-and-configure-steps/configure-action-steps/delay
12. Novu, Self-hosting with Docker: https://docs.novu.co/community/self-hosting-novu/deploy-with-docker
13. Knock, Pricing: https://knock.app/pricing
14. Courier, Inbox JavaScript SDK: https://www.courier.com/docs/platform/inbox/web/javascript-sdk
15. Courier, Postmark integration: https://www.courier.com/docs/external-integrations/email/postmark
16. Courier, Automation steps (delay): https://www.courier.com/docs/journeys/automations/steps
17. Courier, Journeys delay node: https://www.courier.com/docs/journeys/nodes/delay
18. MagicBell, API reference: https://developer.magicbell.com/reference
19. MagicBell, React Headless SDK: https://magicbell.com/docs/libraries/react-headless
20. MagicBell, Docs home (channels, Node client): https://www.magicbell.com/docs
21. MagicBell, SMTP channel: https://www.magicbell.com/docs/channels/email/smtp
22. MagicBell, Pricing: https://www.magicbell.com/pricing
23. Novu, Community Edition self-hosting changelog: https://novu.co/changelog/novu-community-edition-v220-self-hosting/

Notes on confidence: Novu's MIT licence is described on its changelog and community channels. I did not read the LICENSE file. Courier's raw inbox REST paths and MagicBell's delay support were not found in the docs I read, so treat both as unverified rather than absent.
