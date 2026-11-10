# Knock behind the `NotificationStore` interface

Research for [#16](https://github.com/marktarry-mobysoft/quintus-cadre/issues/16), a child of the map [#11](https://github.com/marktarry-mobysoft/quintus-cadre/issues/11). It builds on [#13](https://github.com/marktarry-mobysoft/quintus-cadre/issues/13) (`docs/research/notification-backing.md` on the `research/notification-backing` branch), which recommended in-house SQLite behind a `NotificationStore` interface and named Knock as the route to scheduling. This document does not repeat that comparison. It looks only at how Knock would fit.

Sources were read on 2026-11-10: Knock's docs and API reference, its pricing and legal pages, and the type definitions of `@knocklabs/node` 1.41.1 (Apache-2.0, published 2026-11-10), unpacked from npm. Items marked **Unconfirmed** were not stated by a primary source. Check them in a Knock test environment before relying on them.

## Recommendation

**Don't adopt Knock for v1. Shape the interface so a Knock adapter can be added later without touching any route.** Knock can run inactivity nudges, but adopting it now doesn't remove any work we would otherwise do:

1. **We need a local implementation of delayed nudges anyway.** Knock has no credential-free mode [#13], so `npm run dev` and `npm run test` need an in-house store that also handles delays. That store turns out to be cheap (see "In-house fallback" below). An in-app nudge needs no scheduler at all: it is a row with a future `deliverAt`, and the feed query hides it until that time. Only a delayed *email* needs something to wake up, and that is one sweep function.
2. **The safe Knock design for nudges still calls back into Cadence.** Knock's cancellation is asynchronous and can race a re-trigger (see below). The robust pattern is to let Knock wait, then have it ask Cadence whether the nudge is still due. So Knock would be a hosted timer plus a feed store, and our database would still make the decision.
3. **Server-side use costs us an HTTP round trip and rate-limit care on hot paths.** The unread badge is read in the root loader on every navigation. With Knock, that becomes a call to Knock's feed endpoint each time.
4. **Cost has a cliff.** It is free up to 10,000 messages a month. After that, the first paid tier is $250 a month [13].

**When to revisit:** add the Knock adapter if any of these happens: (a) the in-process email sweep proves unreliable in production (for example, several server instances, serverless hosting, or no long-lived process); (b) non-developers need to edit notification timing or content; (c) we want live updates without building them ourselves; (d) we need per-message delivery observability. The interface below is designed so that adding the adapter is a contained change.

If the team adopts Knock anyway, use it like this: **in-app channel only, our own `sendEmail` for email, preferences mirrored in our database, and nudges built as "delay, then fetch a Cadence check endpoint, then send"**. That keeps Knock thin and easy to swap out.

## 1. Inactivity nudges in Knock

### The building blocks Knock provides

| Mechanism | What it does | Limits and caveats |
| --- | --- | --- |
| **Delay step** [1] | Can be **fixed**, **dynamic** (an ISO-8601 timestamp, or a duration taken from `data`, `recipient`, `actor` or `vars`), **relative** (a fixed interval before or after a dynamic timestamp), or **window** (for example, business hours in the recipient's timezone). | At most 365 days. If a dynamic key is missing or invalid, the delay is *skipped*, so the run continues immediately. "Recipient properties and preferences are re-read from your Knock environment each time a step executes." [1] |
| **Cancellation** [2][3][N1] | `workflows.cancel(key, { cancellation_key, recipients? })` "will cancel any queued workflow runs associated with that key/cancellation key pair". Works only on runs paused at a delay, batch, wait-for-event or fetch-retry step. | **Asynchronous.** A `204` means the cancel was *enqueued*, not performed. Knock advises not cancelling within 5 s of the trigger, and warns that a cancel "may overtake and cancel the subsequent workflow". The SDK says the cancellation key "should be unique across trigger requests to avoid unintentional cancellations." [2][N1] |
| **Step conditions** [4][5] | Evaluated *when the step executes*. If false, the step is skipped. Conditions can reference `data.*`, `recipient.*`, `actor.*`, `vars.*`, `tenant.*` and `refs.<step>.*`. Timestamp operators include `is_timestamp_before` with relative arguments such as "7 days ago". | Relative times must be at least 15 minutes. [5] |
| **Fetch step** [6] | An HTTP GET or POST to our endpoint, with the URL, headers and body templated from `recipient`, `data` and `vars` (secrets go in `vars`). The response JSON is merged into `data` for later steps. | Needs a `2xx` response within 15 s. 5xx, 429 and timeout responses are retried after 30 s and again after 60 s; after that the run halts. **Unconfirmed:** the page says merged data is available to later steps but does not explicitly say that *step conditions* can read it. |
| **Wait for event** [7] | Pauses until a matching event arrives or a timeout passes, up to **30 days**. You set what happens on a match (halt or continue) and on timeout (halt or continue), and `refs.<step>.matched` is available for branching. | Events have to come in through a configured *integration source*, such as a custom HTTP source [8]. Matching is always scoped to the run's recipient, and the *first* matching event claims the wait. Events outside the wait window are ignored. |
| **Throttle step** [9] | Caps how many times a workflow runs per recipient within a window. | I did not read the detail page (throttle key options, window limits). **Unconfirmed.** |
| **Schedules** [10] | One-off (`scheduled_at`) or recurring schedules, updated or deleted by `schedule_id`. Deleting one "cancels any already-enqueued runs". | Re-arming would mean storing a `schedule_id` per enrollment and calling `schedules.update` on each activity. |
| **`settings.skip_delay`** on trigger [N1] | A per-trigger flag that skips delay steps. Useful in a Knock test environment. | Found only in the SDK types, not in a prose docs page. |

### Can "7 days with no Watched progress on Course X" be expressed without our own scheduler?

**Yes. Knock is the timer.** There are three workable shapes. They differ in how the "they watched again" case is handled.

**A. Delay, fetch a check, then send (recommended if we adopt Knock).**
- On each watch event (debounced, say at most once a day per enrollment), Cadence records a fresh *arm token* for `(userId, courseId)` in its own database. It then triggers `course-inactivity-nudge` with `data: { course_id, arm_token, deliver_at }`.
- The workflow runs: **delay** (dynamic, until `data.deliver_at`), then **fetch** `POST /api/notifications/nudge-check` with the token and a shared secret from `vars`, then a **step condition** `data.send == true`, then an **in-app** step.
- The Cadence endpoint returns `send: true` only if that token is still current, the enrollment isn't complete, and preferences allow it. It consumes the token atomically.
- Older runs whose token has been superseded skip themselves, so we **never need to cancel anything**. That avoids the cancel/re-trigger race entirely, and an extra run costs no messages, because Knock bills sends, not triggers [13].
- If we keep email in Cadence, the same endpoint can call `sendEmail` when it returns `send: true`. Then email needs no Knock channel at all.
- Costs: one public, authenticated endpoint that Knock must be able to reach, and dependence on the fetch step's retry behaviour.

**B. Wait for event (pure Knock).**
- On each watch event, Cadence posts a `course.watched` event to a Knock custom HTTP source *and* triggers a new run.
- Each run waits up to 7 days for a `course.watched` event that matches its `course_id`. On a match it halts. If the wait times out, it continues to the in-app step.
- **Risk:** the event meant to halt the *previous* run might also be claimed by the *new* run, if the new run reaches its wait step before the event is processed. Then nobody gets nudged. Whether a match condition can compare the event's timestamp with the run's own trigger time is **unconfirmed**.
- This option also needs a source integration set up per environment.

**C. Cancel, then re-trigger with a stable key (avoid).**
- Using `cancellation_key = inactivity:{userId}:{courseId}` with a cancel followed by a trigger on each watch is the obvious design. Knock's own docs warn against it: cancels are async and can overtake the new run [2].
- It can be made safe only by using a *unique* key per trigger and storing the previous one, which needs the same local state as option A but with weaker guarantees.

**Per-user (not per-course) inactivity can be done with no callback at all.**
- Keep a `last_watched_at` user property up to date with `users.update`, debounced.
- The workflow then runs: delay 7 days, then the condition `recipient.last_watched_at is_timestamp_before "7 days ago"`, then send. This works because recipient properties are re-read at each step [1][5].
- Doing the same per course would need a condition path keyed by course id, such as `recipient.last_watched.c42`. Whether condition variable paths can be templated is **unconfirmed**, so per-course inactivity points to option A.

**Our activity signal.**
- A new `video_watch_events` row (or a change to `lesson_progress`) for a lesson whose module belongs to Course X.
- `app/db/schema.ts` has `videoWatchEvents(userId, lessonId, createdAt)` and `lessonProgress(userId, lessonId, status, completedAt)`. Mapping a lesson to its course goes through `lessons.moduleId` and then `modules.courseId`.
- `enrollments.completedAt` gives us "stop nudging".

## 2. Interface shape and how each operation maps to Knock

All calls are server-side with the secret key, using `@knocklabs/node` [N1]. No Knock UI components are used. Rate-limit tiers come from the API reference: Tier 1 = 1 req/s, Tier 2 = 5, Tier 3 = 60, Tier 4 = 200, Tier 5 = 1,000 [11][12]. With a secret key, limits are scoped **per endpoint per environment**, *not* per user. The exception is the feed endpoint, which "is always scoped per-user and per-environment" [14].

| Operation | Knock (Node SDK) | Tier | Notes |
| --- | --- | --- | --- |
| `notify` (immediate) | `workflows.trigger(key, { recipients: [{ id, email?, name? }], actor?, data, tenant? })` | 5 | Identifies recipients inline [N1]. Up to 1,000 recipients per call. The `Idempotency-Key` header is honoured for 24 h on trigger only [11]. Put everything the UI needs in `data` (type, ids, short display strings), because feed items carry `data` [14]. That way Knock templates can stay trivial. |
| `armNudge` / `disarmNudge` | `workflows.trigger` with a delay workflow (option A). Disarming means deleting our local arm token. A `workflows.cancel` call is optional and only for housekeeping. | 5 | See section 1. |
| `listFeed` | `users.feeds.listItems(userId, channelId, { page_size, after, status, archived })` | 2 (per user) | Returns `entries` plus `meta.{unread_count, unseen_count, total_count}` and `page_info` cursors. `status` can be `'unread' \| 'read' \| 'unseen' \| 'seen' \| 'all'` [N1]. |
| `unreadCount` | The same call with `page_size: 1`, reading `meta.unread_count` | 2 (per user) | **This is a Knock round trip on every navigation if it lives in the root loader.** Consider caching it briefly. |
| `markRead` / `markSeen` / `archive` | `messages.batch.markAsRead({ message_ids })`, `.markAsSeen`, `.archive` | 3 | The single-message endpoints are Tier 2: **5 req/s for the whole environment** with a secret key. Always use the batch endpoints [12]. **Security:** a secret key can mark *any* user's message, so we must check that the ids belong to the current user's feed first. |
| `markAllRead` | `channels.bulk.updateMessageStatus(channelId, 'read', { recipient_ids: [userId] })` | not read | Returns an asynchronous `BulkOperation` (`status: "processing"`) [15], so the badge may lag briefly after "mark all read". **Unconfirmed:** how long it takes to complete. The fallback is to list unread items and then batch-mark them, which is what #13 described. |
| `getPreferences` / `setPreferences` | `users.getPreferences(userId, 'default')` and `users.setPreferences(userId, 'default', { categories, workflows, channel_types })` | not read | See section 4. |
| identity | `users.update(id, { email, name })` (identify), `users.delete(id)`, `users.merge` | 3 | See section 5. |

**Where the in-house fallback can't match Knock** (it lacks a hosted timer, live updates and delivery logs), it behaves as follows:

- **Delays in tests:**
  - The store takes an injected clock (`now: () => Date`). Arming writes a `notifications` row with `deliverAt = now + 7d` and a unique `nudgeKey` while it is pending. Re-arming *updates* that row's `deliverAt`, and disarming deletes it, all synchronously in SQLite, so there are no races.
  - `listFeed` and `unreadCount` filter `deliverAt <= now()`, so a test advances the clock and asserts that the nudge appears.
  - `deliverDue(now)` sends any due emails through `sendEmail` with the `outboxTransport`, and the test calls it explicitly.
- **Delays in dev:**
  - The same rows are used. In-app nudges appear on their own once due, because they are filtered at read time.
  - For emails and demos, add a DevUI action (`app/components/dev-ui.tsx`) that sets pending rows' `deliverAt` to now and runs `deliverDue`. Due emails then land in `.outbox/`.
- **Delays in production (in-house):** `deliverDue` needs something to call it. That could be a `setInterval` in the server process, or an opportunistic call from a request. This is the fragile spot #13 flagged, and the main trigger for adopting the Knock adapter.

## 3. Email: Knock's Postmark channel or our own `sendEmail`

| | Knock email channel with Postmark | Knock in-app only, with our `sendEmail` |
| --- | --- | --- |
| Setup | Postmark API key and From address go into Knock's channel settings. Open and link tracking can be done by Knock or by Postmark. Sends to the `outbound` stream unless overridden. Has a sandbox mode [16]. | Nothing new. `app/lib/mailer.server.ts` is unchanged. |
| Templates | They live in Knock (shown in the dashboard). Email client previews are on paid plans only [13]. | They stay in our code, as now. |
| Billing | **Each email is a separate Knock message**, so an in-app plus email notification counts twice [13]. Postmark also bills separately. | Only in-app deliveries count. This roughly halves Knock usage if most notifications also email. |
| Preferences | Knock enforces the per-channel preference during the run. | We check our own preference before calling `sendEmail`. For delayed nudges, the option-A check endpoint does this at send time. |
| Local fallback | Still needs our own outbox path in dev and tests, so email logic exists in two places. | One email path everywhere. |
| Delayed email | Knock handles it. | Handled by the option-A callback, which sends at fire time. With no Knock, `deliverDue` does it. |

**Recommendation: in-app only in Knock, with email through `sendEmail`.** Email already meets every constraint, and moving it into Knock would add cost and a second template system without removing our outbox fallback. Knock's webhook channel [#13 source 4] is another way to have Knock call us for email, but the option-A fetch step already gives us that hook.

## 4. Preferences for a minimal settings screen we render ourselves

**Knock's model covers it** [17]:

- A `PreferenceSet` (id `default`) holds booleans under `categories`, `workflows`, `channel_types` and `channels`.
- Anything left unset defaults to `true`.
- A category set to `false` blocks every workflow in that category, even if a channel is enabled.
- A specific channel setting overrides its channel-type setting.
- There is an environment-wide default set (configured in the dashboard), plus per-tenant sets.

A minimal screen of the form "Replies to my comments: in-app [x] email [x]; Course reminders: in-app [x] email [ ]" maps onto categories (`comments`, `reminders`) with `channel_types: { in_app_feed, email }`. `setPreferences` overwrites the set by default. Use `__persistence_strategy__: "merge"` for partial updates [17]. Knock also offers a hosted preference center (`users.preferenceCenter.generateSignedURL`) [N1], which is ruled out because we render our own UI.

There is a wrinkle. If email stays in `sendEmail` (section 3), Knock only enforces the in-app half of each preference. Either read Knock's set before every email (an extra round trip), or **keep preferences in our own `notification_preferences` table and don't use Knock's**. With preferences in our table, we skip the trigger when in-app is off, and the nudge-check endpoint enforces both channels. **I recommend the second.** It keeps a single source of truth that works the same with no Knock key, and avoids two-way sync.

## 5. Identity and data sync

- **What Knock needs:**
  - Only `id` is required. Use our internal id, prefixed if useful (`user_123`), at most 256 characters, with no `/` or `#`, and it can never change.
  - Add `email` only if Knock sends email, and `name` or `avatar` only if Knock templates render them.
  - "User data must be synchronized to Knock before you notify a user", which inline identification on `workflows.trigger` covers [18][N1].
  - Knock describes itself as "a cache of user information" [18].
- **When:**
  - Inline identify on each trigger is enough for in-app-only use.
  - Call `users.update` when a user's name or email changes, if Knock holds them.
  - Call `users.delete` when an account is deleted. In-app messages that referenced the user then show a "missing user" marker [18].
  - Use `users.merge` only if we ever have guest users.
- **What leaves Cadence:**
  - User ids, and email and name if sent.
  - The `data` payload of each trigger: keep it to ids plus short display strings such as the course title and commenter name. Avoid comment bodies.
  - For nudges, course ids and arm tokens. With the per-user property design, `last_watched_at` too.
  - Delivery and engagement events: seen, read, and link clicks [14].
- **Where it goes:**
  - Knock's subprocessor list shows US locations only.
  - EU transfers rely on SCCs and the EU-U.S. Data Privacy Framework.
  - Knock's docs say EU data residency is "coming soon", expected "by the end of 2026" [19][20]. Cadence sells across countries (PPP pricing), so a DPA [21] and a privacy-policy update would come before launch.
- **Retention:** feed retention is unlimited and configurable on all plans. Logs are kept for 30 days on Free and Starter [13].

## 6. Cost and lock-in

**Pricing** [13]:

- **Free:** 10,000 messages a month, not hard-capped. If we go over, Knock asks for billing the following month.
- **Starter:** $250 a month including 50,000 messages, then $0.005 each.
- A **message** is "one delivery to one user on one channel". Triggers, cancelled runs and runs that send nothing are not billed.
- Delays aren't mentioned on the pricing page. Preferences, batching, fetch, conditions, scheduled workflows and unlimited environments are on all plans.

**Rough volume** (illustrative assumptions, not measured):

| Assumption (per month) | In-app only | In-app + Knock email |
| --- | --- | --- |
| 1,000 active Students, each with ~3 comment-reply or instructor notifications | 3,000 | 6,000 |
| 25% of enrollments go quiet, giving 1 nudge each over ~1,500 enrollments | 375 | 750 |
| Instructors: 50 receiving ~40 new-comment notifications each | 2,000 | 4,000 |
| **Total** | **~5,400 (Free)** | **~10,750 (over Free, so roughly $250/mo)** |

So at Cadence's likely early volume, Knock is free if it carries in-app only. It hits the $250 cliff at about double that volume, or at once if email also goes through Knock.

**Lock-in and swap cost:**
- **Low, if the interface holds.** Routes call only `NotificationStore`, and swapping the implementation is a matter of environment configuration (`KNOCK_API_KEY` set or not, mirroring `POSTMARK_SERVER_TOKEN`).
- **What lives in Knock:**
  - workflows (delay, fetch, condition, in-app), which take minutes to recreate elsewhere because the logic stays in our check endpoint;
  - thin templates;
  - **feed history and read state**. Leaving Knock means exporting with `users.listMessages` per user [N1] and backfilling, or accepting that the feed starts fresh.
- **What stays in Cadence:** preferences (section 4), email, and the nudge decision logic, so there is nothing to migrate for those.

## Interface sketch

```ts
// app/lib/notifications.server.ts
// Same shape as mailer.server.ts: an interface, a Knock implementation when
// KNOCK_API_KEY is set, and a SQLite implementation otherwise (dev, tests).

export type NotificationType =
  | "comment.reply"          // Student: someone replied to my comment
  | "comment.new_on_course"  // Instructor: new comment on my course
  | "course.inactivity_nudge";

export type Channel = "in_app" | "email";

export type NotificationPayload = {
  type: NotificationType;
  actorUserId?: number;
  subject: { type: "comment" | "course"; id: number };
  // Short display strings only. No comment bodies (they would leave Cadence).
  data: Record<string, string | number>;
};

export type FeedItem = NotificationPayload & {
  id: string;           // Knock message id or our row id, opaque to callers
  createdAt: string;    // ISO-8601. For nudges, the time it was delivered
  readAt: string | null;
  seenAt: string | null;
};

export type FeedPage = {
  items: FeedItem[];
  unreadCount: number;
  nextCursor: string | null;
};

export type Preferences = Record<
  "comments" | "reminders",           // categories shown on the settings screen
  Record<Channel, boolean>
>;

export interface NotificationStore {
  /** Deliver now to each recipient, after checking their preferences. Emails via sendEmail. */
  notify(recipientUserIds: number[], payload: NotificationPayload): Promise<void>;

  /**
   * Arm or re-arm a delayed notification. Re-arming the same key replaces the
   * pending one (new deliverAt), so there is never more than one pending nudge per key.
   * Key example: `inactivity:${userId}:${courseId}`.
   */
  armNudge(input: {
    key: string;
    recipientUserId: number;
    deliverAt: Date;
    payload: NotificationPayload;
  }): Promise<void>;

  /** Drop a pending nudge (for example, the course was completed). Does nothing if already delivered. */
  disarmNudge(key: string): Promise<void>;

  listFeed(
    userId: number,
    opts?: { cursor?: string; limit?: number; unreadOnly?: boolean }
  ): Promise<FeedPage>;
  unreadCount(userId: number): Promise<number>;

  /** Ids must come from this user's feed. Implementations verify ownership. */
  markRead(userId: number, ids: string[]): Promise<void>;
  markAllRead(userId: number): Promise<void>;
  archive(userId: number, ids: string[]): Promise<void>;

  getPreferences(userId: number): Promise<Preferences>;
  setPreferences(userId: number, prefs: Partial<Preferences>): Promise<void>;

  /** Send emails for nudges that are now due. A no-op in the Knock implementation (Knock is the timer). */
  deliverDue(now?: Date): Promise<number>;
}
```

**How the two implementations behave:**

- **SQLite (no key; dev, tests, and production until Knock is needed):**
  - A `notifications` table gets `deliverAt` (equal to `createdAt` for immediate notifications) and a nullable `nudgeKey` with a unique index on pending rows.
  - `armNudge` upserts on `nudgeKey` where `deliverAt > now`. `disarmNudge` deletes the pending row.
  - Feed and count queries add `deliverAt <= now()`, so in-app nudges need no scheduler.
  - `deliverDue` emails the rows that are due and not yet emailed, and stamps `emailedAt`.
  - The clock is injectable for tests. A DevUI action fast-forwards pending rows.
  - Preferences live in a `notification_preferences` table, shared with the Knock implementation.
- **Knock (`KNOCK_API_KEY` set):**
  - `notify` calls `workflows.trigger` (in-app step only), then `sendEmail` if the email preference is on.
  - `armNudge` stores a fresh arm token in a small `nudge_arms(key, token, deliverAt)` table and triggers the delay-fetch-condition-in-app workflow (option A). `disarmNudge` deletes the arm.
  - The check endpoint consumes the token, checks enrollment and preferences, sends the email, and returns `{ send }`.
  - Feed, count, read and archive calls map as in the section 2 table, and `deliverDue` is a no-op.

The caller side is the same for both. In the action that records a watch event, if the enrollment has no watch event in the last 24 h, call `armNudge({ key: "inactivity:<userId>:<courseId>", deliverAt: now + 7d, ... })`. When the enrollment completes, call `disarmNudge`.

## Unconfirmed points

- Whether step conditions can read data merged in by a fetch step. Docs say merged data is available "for all subsequent steps", which implies they can, but conditions aren't named [6].
- Whether a condition variable path can be templated, for example a per-course key on `recipient`.
- Whether a wait-for-event match condition can compare the event's time with the run's trigger time (option B's race).
- How long `channels.bulk.updateMessageStatus` takes to complete, and its rate-limit tier.
- Throttle step details (keying and window limits) [9].
- Plan availability of the delay and wait-for-event steps: the pricing page doesn't list them, and nothing says they are restricted.
- Whether webhook-channel deliveries count as billable messages. By the "one delivery on one channel" definition they probably do.
- What Postmark "sandbox mode" in Knock does [16].
- `settings.skip_delay` on trigger appears only in the SDK types [N1].
- Volume figures in section 6 are assumptions, not Cadence data.

## Sources

1. Knock, Delay function: https://docs.knock.app/designing-workflows/delay-function
2. Knock, Canceling workflows: https://docs.knock.app/send-notifications/canceling-workflows
3. Knock API, Cancel workflow: https://docs.knock.app/api-reference/workflows/cancel
4. Knock, Step conditions: https://docs.knock.app/designing-workflows/step-conditions
5. Knock, Conditions (variables, operators, relative timestamps): https://docs.knock.app/concepts/conditions
6. Knock, Fetch function: https://docs.knock.app/designing-workflows/fetch-function
7. Knock, Wait for event function: https://docs.knock.app/send-notifications/designing-workflows/wait-for-event-function
8. Knock, Custom source integration: https://docs.knock.app/integrations/sources/custom
9. Knock, Designing workflows overview (function list, throttle): https://docs.knock.app/designing-workflows/overview
10. Knock, Schedules: https://docs.knock.app/concepts/schedules
11. Knock, API reference overview (rate-limit tiers and scoping, idempotency, retention): https://docs.knock.app/api-reference/overview
12. Knock, Messages API reference (per-endpoint tiers): https://docs.knock.app/api-reference/messages
13. Knock, Pricing: https://knock.app/pricing
14. Knock API, List feed items: https://docs.knock.app/api-reference/users/feeds/list_items, and In-app APIs: https://docs.knock.app/in-app-ui/api-overview
15. Knock API, Bulk update message status: https://docs.knock.app/api-reference/channels/bulk/update_message_status
16. Knock, Postmark integration: https://docs.knock.app/integrations/email/postmark
17. Knock, Preferences overview: https://docs.knock.app/preferences/overview
18. Knock, Users: https://docs.knock.app/concepts/users
19. Knock, Subprocessors: https://knock.app/legal/subprocessors
20. Knock, Privacy policy (DPF, SCCs): https://knock.app/legal/privacy-policy
21. Knock, Data processing addendum: https://knock.app/legal/data-processing-addendum

- N1. `@knocklabs/node` 1.41.1 type definitions (`resources/workflows.d.ts`, `resources/channels/bulk.d.ts`, `resources/users/feeds.d.ts`, `resources/users/preference-center.d.ts`), and `api.md` in https://github.com/knocklabs/knock-node

The "EU residency by end of 2026" statement came from a search summary of Knock's docs. I did not open the exact page, so confirm it before quoting it externally.
