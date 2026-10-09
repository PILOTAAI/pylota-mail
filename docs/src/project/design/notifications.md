# Notifications and usage alerts

Email that the deployment sends to **people** (console users) about their workspace: usage alerts, new
mail in inboxes they follow, and a daily list of things that need a person. Agents keep using webhooks
and the API; this page is about the humans behind them.

| | |
|---|---|
| Requirements | FR-CON-14, FR-CON-15 and FR-BILL-13 ([PRD](../prd.md)) |
| Edge cases | [O14–O26](../edge-cases.md) |
| Code | `crates/worker/src/notify/{mod.rs, notifier.rs, compose.rs, prefs.rs, unsubscribe.rs}`, `console/pages/notifications.rs`, `crates/core/src/notify.rs` |
| Tables | D1 `notification_prefs`, `tenants.notify_do_id`; `Notifier` Durable Object tables `pending`, `held`, `windows`, `sent`, `meta` ([Data model](data-model.md)) |
| External facts verified on 2026-10-09 | RFC 8058 (one-click unsubscribe with `List-Unsubscribe-Post`), RFC 2369 (`List-Unsubscribe`) |

## 1. Kinds

| Kind | What it says | Who gets it by default | Can be turned off |
|---|---|---|---|
| `usage` | An allowance reached 80% or 100% of its limit (FR-BILL-13) | Owner and admins | Yes, per person |
| `new_mail` | New mail arrived in inboxes the person follows (FR-CON-14) | Nobody (opt-in) | Yes |
| `needs_person` | Daily list of quarantined mail, uncertain sends, failing domains and failing webhooks (FR-CON-15) | Owner and admins, daily | Yes |
| `account` | Security and billing events, one value of `AccountEvent` each: `two_factor_disabled` (two-step verification turned off), `sign_in_method_linked` (a Google or GitHub identity linked), `ownership_transferred` (sent to the previous and the new owner) and `payment_failed` (sent to the owner) | The person concerned, or the owner for billing | No (transactional) |
| `digest` | The items held back that day by a daily cap ([Caps and the daily digest](#caps-and-the-daily-digest)) | A person whose items were held back | Yes: its unsubscribe turns off `usage`, `new_mail` and `needs_person` |

There are no browser or desktop alerts: the console has no JavaScript (FR-CON-1). The Overview banners
(Cloud sign-up §8) show the same states when someone is signed in.

**Nothing in a notification comes from mail content.** A `new_mail` email names the inbox and counts
messages ("3 new messages in bookings.brightwell@pylotamail.com, 2 waiting for a reply"). It never includes
a subject, a sender, a snippet or an attachment name. Untrusted text stays out of notifications, and the
notification is safe to read on a lock screen.

## 2. Preferences

Set per person and per workspace at `/console/settings/notifications`. API keys are not people, so there
is no REST endpoint for preferences.

```sql
CREATE TABLE notification_prefs (
  user_id      TEXT NOT NULL REFERENCES users(id),
  tenant_id    TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('usage','new_mail','needs_person')),
  mode         TEXT NOT NULL CHECK (mode IN ('off','instant','hourly','daily')),
  filter       TEXT NOT NULL DEFAULT 'all' CHECK (filter IN ('all','needs_reply')),   -- new_mail only
  identity_ids TEXT,                                -- JSON array; NULL = every inbox (new_mail only)
  paused_reason TEXT CHECK (paused_reason IN ('bounce','complaint')),
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, tenant_id, kind)
);
```

- A missing row means the default: `usage` = `instant` and `needs_person` = `daily` for owners and admins,
  `off` for members and viewers; `new_mail` = `off` for everyone.
- `usage` accepts only `off` and `instant`. `needs_person` accepts only `off` and `daily`.
- Removing a member deletes their rows for that workspace, and pending notifications for them are dropped
  ([O19](../edge-cases.md)). Person erasure deletes all their rows.

## 3. How notifications are produced

A `Notifier` Durable Object, one per tenant (binding `NOTIFY`), owns coalescing, schedules and caps. It
is SQLite-backed like the other objects.

| Source | Path into the Notifier |
|---|---|
| `message.received`, `message.released` and `message.triaged` events | The webhook dispatcher (`consumers/webhooks.rs`) already reads every outbox event. For these three types it also sends `NotifierRequest::Event { tenant_id, identity_id, message_id, flags }` whenever the tenant has any `new_mail` preference that is not `off`, whatever its filter (cached for 60 seconds). `message.triaged` therefore reaches the Notifier for `filter = all` too, which is where `needs_reply_count` comes from. Events re-emitted by a re-parse (`reprocessed: true`) are never handed over, so a re-parse never notifies ([Webhooks › Handing new mail to the Notifier](webhooks.md#handing-new-mail-to-the-notifier)) |
| An allowance crossing 80% or 100% | `TenantQuota` calls `NotifierRequest::UsageThreshold { feature, threshold, used, granted, period }` when a confirmed hold first crosses the threshold in a period ([§4](#4-usage-alerts)) |
| "Needs a person" items | The Notifier's daily alarm at 09:00 in the tenant's time zone reads the counts the Overview uses |
| Account events | The code that performs the action calls `NotifierRequest::Account { user_id, event }` after its D1 batch commits: the console handlers for `two_factor_disabled`, `sign_in_method_linked` and `ownership_transferred` ([Console › Account emails](console.md#account-emails)), and the billing webhook for `payment_failed` ([Billing › Applying state](billing.md#applying-state)). One rule picks the Notifier: the one of the person's last-used workspace (`users.last_tenant_id`); when that is unset or names a workspace that is gone, the one of the workspace where the event happened; for an event in no workspace (a sign-in method linked before any session exists), the default tenant's. The email names the workspace concerned, whichever Notifier sends it |
| Member removal | The member-removal handler (and a member leaving) calls `NotifierRequest::MemberRemoved { user_id }` after the D1 batch that deleted their `notification_prefs` rows; the Notifier drops their `pending`, `held` and `windows` rows ([O19](../edge-cases.md)) |

**Which messages count for `new_mail`.** Only messages that become visible in the inbox: status
`received`, not quarantined, not hidden, not marked spam, not loopback, and not on a test tenant
([O15](../edge-cases.md)). A message released from quarantine counts when it is released.

**Coalescing for `new_mail` ([O14](../edge-cases.md)):**

| Mode | Rule |
|---|---|
| `instant` | The first message opens a 2-minute hold; one email then covers everything that arrived. After it, at most one email per person and inbox every 10 minutes; later messages wait for the window |
| `hourly` | One email at the top of each hour that had messages |
| `daily` | One email at 09:00 local time, with counts per inbox |

**Waiting for triage ([O16](../edge-cases.md)).** "Triage says `needs_reply`" means a `message.triaged`
event whose `triage.needs_reply` is at least 0.5, the threshold of the search operator `is:needs_reply`.

- With `filter = needs_reply`, a visible message is not counted on arrival. The Notifier writes a `held`
  row `(message_id, identity_id, user_id, until = now + 5 minutes)` for each person with that filter who
  follows the inbox. On `message.triaged` for the message, it deletes those rows: with `needs_reply`
  the message is counted (`count` and `needs_reply_count`); with any other result, `failed` included, it
  is dropped. When `until` passes with no triage event, the message is counted (`count` only). That
  covers triage that was skipped (no allowance) or disabled, which emits no event, so no skip signal is
  needed. The earliest `until` is the meta key `alarm:held`.
- With `filter = all`, a visible message is counted on arrival. A later `message.triaged` with
  `needs_reply` adds 1 to `needs_reply_count` of the `pending` row that counted it, while that row is
  still waiting for its window. Message IDs are ULIDs, so the Notifier compares the message's time with
  the row's `first_at`: a message older than the row was announced by an earlier email, and its triage
  changes nothing.

### Caps and the daily digest

At most 50 notification emails per person per day, and 200 per workspace per day, in the tenant's time
zone, across the kinds `usage`, `new_mail` and `needs_person` ([O24](../edge-cases.md)). `account`
emails and the `digest` itself are not counted. Past a cap, an item due that day is folded into the
person's `digest` row in `pending` (kind `digest`, `ref` `-`) instead of being sent, and the person's
settings page says so.

- **Its own kind.** The `digest` is one email per person per day at most, sent by the daily alarm at the
  next 09:00 in the tenant's time zone, with the `Idempotency-Key` `notify:{user_id}:digest:-:{day}`.
- **What it lists.** Counts only, from the row's `detail_json`: per inbox, the messages that `new_mail`
  emails would have announced (and how many wait for a reply); each usage threshold crossed (feature and
  80% or 100%); whether the "needs a person" list was held back. Each line links to the console screen
  for it. Like every notification it holds no mail content.
- **Unsubscribing.** It carries `List-Unsubscribe` and `List-Unsubscribe-Post` like the other kinds. Its
  token names the kind `digest`, and the one-click `POST` turns `usage`, `new_mail` and `needs_person`
  off for that person and workspace, because those are the kinds it summarises; `account` emails
  continue. The digest has no preference row of its own: it exists only while one of those kinds is on.
- Items for a paused person, a suspended tenant or `PM_NOTIFICATIONS=off` are not folded into a digest;
  they are not sent at all, as before.

## 4. Usage alerts

- **Features:** every allowance in the plan catalog (`inboxes`, `sends`, `triage`, `custom_domains`,
  `storage_gb`, `seats`). On a deployment with `PM_BILLING=off`, usage alerts are not sent at all: no
  feature has a limit ([O23](../edge-cases.md)). The daily caps in tenant policy are not allowances; they
  still return `429` and emit `quota.warning` to webhooks.
- **Thresholds:** 80% and 100% of `granted`, including top-ups.
- **Once per threshold per period ([O20](../edge-cases.md)).** For allowances that reset (`sends`,
  `triage`), each threshold alerts at most once per billing period, even if holds are released and the
  usage crosses again. For counts that do not reset (`inboxes`, `custom_domains`, `seats`, `storage_gb`),
  a threshold alerts when it is crossed upwards, with a 24-hour cooldown per feature and threshold
  ([O21](../edge-cases.md)). `TenantQuota.meta` keys `alerted:{feature}:{threshold}:{period}` record it:
  for `sends` and `triage`, `{period}` is the period's `period_start` and the value is `1`; for the count
  features, `{period}` is the literal `count` and the value is the time of the last alert, which the
  cooldown compares with.
- **Content:** the feature in plain words, used and granted, the reset date (or "does not reset"), what
  happens at 100% ("sends return `402 billing_limit` until 1 November"), and links to Plan and usage and to
  buying a top-up (owners only).
- **Webhooks are unchanged.** `quota.warning` and `billing.limit_reached` events still go to endpoints, so
  agents learn about limits by the same route as before.

## 5. The emails

- Sent from the reserved system identity at `PM_SYSTEM_FROM`, through the normal outbound pipeline with
  `kind: "transactional"`. They take part in suppressions and bounce handling like any message.
- Subjects: `[Pylota Mail] Sends at 80% for Brightwell`, `[Pylota Mail] 3 new messages in bookings.brightwell@…`,
  `[Pylota Mail] 4 things need you in Brightwell`, `[Pylota Mail] Today's held-back notifications for Brightwell`.
- Plain text and a minimal HTML part with no images and no tracking.
- Every `usage`, `new_mail`, `needs_person` and `digest` email carries `List-Unsubscribe: <https://{PM_CONSOLE_HOST}/console/notifications/unsubscribe?t={token}>`
  and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). The token is a MAC under the current
  `link` key with its kid, binding the user, workspace and kind, valid for 90 days. A `POST` sets that
  kind to `off` for that person and workspace, without sign-in (for `digest`, the three kinds it
  summarises). An expired or foreign token changes nothing and shows a page linking to settings
  ([O18](../edge-cases.md)). `account` emails have no unsubscribe header; they link to settings instead.
- **The unsubscribe routes** (`GET` shows a confirmation page with a one-click form, `POST` turns the kind
  off) need no session and are exempt from the console's CSRF token and `Origin` check
  ([W16](../edge-cases.md)): a mail provider sends the RFC 8058 `POST` without either. The token is their
  only authority, and it can only turn one kind off. They are served even with `PM_CONSOLE=off`, like the
  invitation-accept pair, so the header of every email works. The token verifies under any `link` key
  still inside its verify window, so after a `link` rotation an older token stops working once its key
  leaves the 7-day window, even inside its 90 days, and gets the expired-token page; every new email
  carries a token under the current key.
- **Bounces and complaints ([O17](../edge-cases.md)).** A hard bounce or complaint on a notification
  sets `paused_reason` on every preference of that person, in every workspace (a kind with no row gets
  its default row first, so the pause is recorded), and suppresses the address as usual (FR-DLV-2). The
  system identity's mailbox recognises a notification by the message's `metadata.notify_user_id`, which
  the Notifier sets on every send (mailboxes keep only a hash of the idempotency key, so the key cannot be
  used for this). While a person is paused, the Notifier sends them nothing but `account` emails, and the
  console shows a banner asking them to confirm their address. Confirming it clears `paused_reason` and
  removes the system identity's suppression of that address, which is the person's own. It needs a
  session but not a recent sign-in: while the address is suppressed, the system identity's mail to it,
  sign-in and re-authentication codes included, is not delivered, so the person confirms from a session
  they already have, or after signing in with Google or GitHub.

## 6. Time zones and schedules

Daily items run at 09:00 in the tenant's time zone (`tenants.timezone`). A time-zone change takes effect
from the next day; a day is never sent twice or skipped ([O22](../edge-cases.md)). Across a daylight-saving
change, 09:00 local is computed for each day with the time-zone database.

## 7. When system mail cannot be sent

System mail uses the platform domain, which has no fallback ([Fallback behaviour](identity-domains.md#fallback-behaviour)).
While the platform domain is `failing`, notification sends fail like any other send from it. The Notifier
keeps the items and retries hourly for 24 hours, and the operator is alerted by the existing platform
domain alert ([O25](../edge-cases.md)).

The system identity is exempt from the tenant daily cap and from abuse auto-pause
([Identities and domains › The system identity](identity-domains.md#the-system-identity)), so a submit
through it is refused for only three reasons: `429 daily_cap_reached` (its own `send_policy.daily_cap`
of 50,000 is spent), `409 identity_paused` (an operator paused it by hand) and `409 domain_not_ready`
(the platform domain is not verified yet). The Notifier handles each one as in O25: it keeps the item in
`pending` (`attempts` + 1, `due_at` one hour later), retries hourly for 24 hours and then drops it,
counting `notifications_failed_total`. `account` items are kept the same way. On the first such refusal,
and again after each hour in which they continue, it reports the state alert `system_mail_blocked`
(with the error code; [Observability › Alert list](observability.md#53-alert-list)), because the same
refusal also stops sign-in and invitation mail.

A suspended tenant gets `account` emails only ([O26](../edge-cases.md)).

## 8. Notifier object

| Table | Holds |
|---|---|
| `pending` | Items waiting for their window: `(user_id, kind, ref, count, needs_reply_count, detail_json, first_at, due_at, attempts)`. `ref` is the identity ID for `new_mail`, `{feature}:{threshold}` for `usage`, the event for `account`, and `-` for `needs_person` and `digest`, so two alerts due together never share a row |
| `held` | Messages waiting up to 5 minutes for triage for a person with `filter = needs_reply`: `(message_id, identity_id, user_id, until)`, one row per message and person ([Waiting for triage](#3-how-notifications-are-produced)). Deleted when the message's `message.triaged` arrives, when `until` passes (the message is then counted), or when the person is removed |
| `windows` | Last send per `(user_id, kind, ref)`, for the 10-minute rule. The daily alarm deletes rows older than 1 day |
| `sent` | Per-day counters per person and for the workspace, for the caps. The daily alarm deletes days older than 2 days |
| `meta` | `tenant_id` (the owner, written by `NotifierRequest::Init`), `schema_version`, `alarm:send` (the earliest `due_at`), `alarm:held` (the earliest `held.until`), `alarm:daily` (the next 09:00 in the tenant's time zone), `prefs_cache_at` |

The object's ID is minted with the tenant row and stored in `tenants.notify_do_id`, like `quota_do_id`
for `TenantQuota`, and the object takes `NotifierRequest::Init` before anything else ([Design § 5](index.md#5-internal-durable-object-rpc)).
Its single alarm is set to the earliest of `alarm:send`, `alarm:held` and `alarm:daily` ([Design § 4](index.md#4-durable-object-transactions),
rule 5) and drives sending. Each send is idempotent: the
outbound request uses an `Idempotency-Key` of `notify:{user_id}:{kind}:{ref}:{window start}`, so a
retried alarm cannot send twice, and two different items due in the same window never share a key (which
would be refused as `409 idempotency_conflict`).

## 9. Configuration

| Name | Default | Meaning |
|---|---|---|
| `PM_NOTIFICATIONS` | `on` | `off` sends only `account` emails |
| Binding `NOTIFY` | – | Durable Object namespace, class `Notifier` |

## 10. Tests

| Test | Covers |
|---|---|
| `it::notify::new_mail_coalesces` | 500 messages in a minute → one email per inbox per window ([O14](../edge-cases.md)) |
| `it::notify::invisible_mail_never_notifies` | Quarantined, hidden, spam, loopback and test-tenant mail → nothing ([O15](../edge-cases.md)) |
| `it::notify::needs_reply_filter_waits_for_triage` | With `filter = needs_reply`: a `held` row per person; `message.triaged` with `needs_reply` ≥ 0.5 → counted, any other result (`failed` included) → dropped; no triage event within 5 minutes (triage skipped for allowance, or disabled) → counted at `until`. With `filter = all`: a later `message.triaged` raises `needs_reply_count` of the waiting email ([O16](../edge-cases.md)) |
| `it::notify::bounce_pauses_prefs` | Hard bounce → `paused_reason` set; banner; confirm clears ([O17](../edge-cases.md)) |
| `it::notify::one_click_unsubscribe` | RFC 8058 `POST` turns one kind off; expired or foreign token changes nothing ([O18](../edge-cases.md)) |
| `it::notify::member_removed_drops_pending` | Removing a member deletes their preferences in that workspace and drops their pending and held items ([O19](../edge-cases.md)) |
| `it::notify::usage_once_per_threshold_per_period` | Crossing 80% three times in a period → one email ([O20](../edge-cases.md)) |
| `it::notify::count_feature_cooldown` | Seats 9→10→9→10 within a day → one email ([O21](../edge-cases.md)) |
| `it::notify::timezone_change` | No day sent twice or skipped ([O22](../edge-cases.md)) |
| `it::notify::billing_off_no_usage_alerts` | `PM_BILLING=off`: sends past every amount that would cross 80% or 100% on a plan send no `usage` email and no `UsageThreshold`; a daily cap still returns `429` and emits `quota.warning` ([O23](../edge-cases.md)) |
| `it::notify::daily_caps` | 51st email for a person, or the workspace's 201st, → folded into the person's `digest`; the next 09:00 sends one `digest` email with counts and no mail content, not counted against the caps; its one-click unsubscribe turns `usage`, `new_mail` and `needs_person` off ([O24](../edge-cases.md)) |
| `it::notify::platform_domain_failing_retries` | Platform domain `failing`: items kept and retried hourly for 24 hours; the platform domain alert fires ([O25](../edge-cases.md)) |
| `it::notify::system_mail_blocked_retries` | A notification submit refused with `429 daily_cap_reached` (system identity's cap lowered), `409 identity_paused` (paused by a platform key) or `409 domain_not_ready`: the item is kept and retried hourly for 24 hours, then dropped; `system_mail_blocked` fires with the code; the default tenant's `tenant_daily_send_cap` never refuses it |
| `it::notify::suspended_tenant_account_only` | A suspended tenant's people get `account` emails and nothing else ([O26](../edge-cases.md)) |
| `core::notify::no_content_in_body` | A rendered notification contains no subject, sender, snippet or attachment name from the source message |
