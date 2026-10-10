# Plans, metering and billing

Binding design for plans, allowances, metering and payment. It implements FR-BILL-1 to FR-BILL-12,
NFR-BILL-1 and NFR-BILL-2, build plan milestone M22, and the edge-case rows W1–W8, W11–W14 and W19 in
the [edge-case register](../edge-cases.md). Usage alerts by email (FR-BILL-13, rows O20, O21 and O23) are
designed in [Notifications and usage alerts](notifications.md#4-usage-alerts); this page owns the
`TenantQuota` side of them ([Usage thresholds](#usage-thresholds)). The user-facing description is
[Plans and billing](../../guides/plans.md); the prices and allowances are set in
[PRD §13](../prd.md#13-business-model-and-pricing).

| | |
|---|---|
| Code | `crates/worker/src/billing/{mod.rs, catalog.rs, quota.rs, stripe.rs, webhook.rs, usage.rs}`, `handlers/{usage.rs, plans.rs, billing.rs}`, console page `console/pages/plan.rs`. The `TenantQuota` class lives in `quota/mod.rs` ([Outbound › TenantQuota](outbound.md#tenantquota)); `billing/quota.rs` adds allowances and holds to it |
| Tables | D1 `billing_accounts`, `billing_events`; `TenantQuota` `allowances`, `holds` ([Data model](data-model.md#1-d1-control-plane), [Other Durable Objects](data-model.md#3-other-durable-objects)) |
| Configuration | `PM_BILLING`, `PM_PLAN_CATALOG`, `PM_BILLING_GRACE_DAYS`, `PM_STRIPE_SECRET_KEY`, `PM_STRIPE_WEBHOOK_SECRET` ([Configuration](../../reference/configuration.md#variables)) |
| Contracts | `GET /v1/usage`, `GET /v1/usage/daily`, `GET /v1/plans`, `GET`/`PATCH /v1/tenants/{id}/billing` ([REST API](../../reference/api.md#usage-and-audit)). The usage routes need `usage:read`, which every tenant and identity key holds implicitly for its own workspace; a platform or partner key must hold it explicitly and pass `tenant_id` (`400 invalid_request` without it); `402 billing_limit`, `409 plan_managed_by_stripe` ([Errors](../../reference/errors.md#policy-and-limits)); `billing.*` events ([Webhook events](../../reference/events.md#workspaces-members-and-billing)) |
| External facts | Stripe documentation, read on 2026-10-09 (see the `Verified` line at the end) |

## Principles

1. **Metering is local.** Every allowance is enforced by the workspace's `TenantQuota` Durable Object, in
   the same Cloudflare account as the mailbox. No metered request waits on a billing provider
   (NFR-BILL-2, [U9](../prd.md#unique-selling-propositions)).
2. **Holds are atomic.** A workspace has exactly one `TenantQuota` object. The check and the hold run in
   one `transaction_sync`, so two requests can never both pass on the last unit (FR-BILL-4, NFR-BILL-1,
   [W1]).
3. **A denial stores nothing.** A refused metered action returns `402 billing_limit` before any
   idempotency record or resource row is written, so the same `Idempotency-Key` works after an upgrade
   (FR-BILL-6, [W3]).
4. **Inbound mail is never refused** for a plan reason (FR-BILL-8, [W7]).
5. **One source of truth per fact.** D1 owns counts (how many identities, domains and members exist).
   Stripe owns subscription state. `TenantQuota` owns monthly consumption and open holds.

## Billing modes

Each workspace has one mode in `billing_accounts.mode` (FR-BILL-1):

| Mode | Plan checks | Used for | `granted` in `TenantQuota` |
|---|---|---|---|
| `metered` | Yes: the plan's allowances plus top-ups | Pylota Mail Cloud customers, or any deployment that sells plans | Numbers from the catalog |
| `exempt` | None | The operator's own workspaces on a deployment that sells plans | `NULL` (unlimited) |
| `disabled` | None. The daily caps in tenant policy (`identity_daily_send_cap`, `tenant_daily_send_cap`, `search.agentic_daily_cap`) still apply, as on every workspace | Self-hosting without billing | `NULL` (unlimited) |

- `POST /v1/tenants` sets the mode from `billing.mode`. The default is `metered` on plan `free` when
  `PM_BILLING=stripe`, and `disabled` otherwise. A tenant created with a partner key gets its partner's
  `default_billing_mode` (`exempt` or `metered`) instead, and the partner key cannot send `billing`
  (`403 scope_denied`); on Pylota Mail Cloud, Pylota's operators are `exempt` this way
  ([REST API › Partners](../../reference/api.md#partners)).
- `PATCH /v1/tenants/{id}/billing` (platform key, `tenants:manage`; a partner key gets `403 scope_denied`) changes `mode`, and sets `plan_id` on a
  workspace with no Stripe subscription (a complimentary plan). On a workspace whose plan is paid through
  Stripe, a `plan_id` change returns `409 plan_managed_by_stripe`. Both are audit-logged
  (`billing.mode_change`, `billing.plan_set`) and a plan change emits `billing.plan_changed` with reason
  `operator`.
- With `PM_BILLING=off`, every workspace behaves as `disabled` whatever its stored mode. The stored mode
  takes effect if the operator turns billing on later ([Self-host mode](#self-host-mode)).
- Holds are still taken in `exempt` and `disabled` mode. They always succeed, and they keep `used` correct,
  so `GET /v1/usage` reports real numbers and a later switch to `metered` starts from true counts.

## Plan catalog

The catalog is data, not code (FR-BILL-2). `PM_PLAN_CATALOG` holds it as JSON. When the variable is unset,
the built-in catalog is used: the Pylota Mail Cloud plans from PRD §13, with every Stripe price ID `null`.
A deployment that sells plans sets `PM_PLAN_CATALOG` with its own Stripe price IDs.

```json
{
  "version": 1,
  "currency": "gbp",
  "interval": "month",
  "default_plan": "free",
  "plans": [
    {
      "plan_id": "free", "name": "Free", "price": 0,
      "included": { "inboxes": 5, "sends": 1000, "triage": 500, "custom_domains": 0, "storage_gb": 1, "seats": 1 },
      "topups": false, "support": "github_issues", "stripe_price_id": null
    },
    {
      "plan_id": "developer", "name": "Developer", "price": 10,
      "included": { "inboxes": 10, "sends": 10000, "triage": 10000, "custom_domains": 5, "storage_gb": 10, "seats": 2 },
      "topups": true, "support": "email", "stripe_price_id": "price_…dev"
    },
    {
      "plan_id": "team", "name": "Team", "price": 49.5,
      "included": { "inboxes": 100, "sends": 100000, "triage": 100000, "custom_domains": 50, "storage_gb": 100, "seats": 10 },
      "topups": true, "support": "priority_email", "stripe_price_id": "price_…team"
    }
  ],
  "topup": {
    "price": 1,
    "units": { "inboxes": 1, "sends": 1000, "triage": 1000 },
    "stripe_price_ids": { "inboxes": "price_…inb", "sends": "price_…snd", "triage": "price_…tri" }
  }
}
```

| Field | Rule |
|---|---|
| `version` | `1`. Unknown versions are refused |
| `currency`, `interval` | `gbp` and `month` in v1.0 (PRD §13: every customer is billed in GBP). Every Stripe price in the catalog must be a monthly recurring price in this currency |
| `default_plan` | Must name a plan with `price` 0 and `stripe_price_id: null`. New metered workspaces start on it, and it applies when a subscription ends |
| `plans[].plan_id` | `^[a-z][a-z0-9_]{0,31}$`, unique. `billing_accounts.plan_id` stores it |
| `plans[].price` | Display only (GBP, excluding VAT). Stripe charges the amount on the Price object, so the two must match |
| `plans[].included` | All six features: `inboxes`, `sends`, `triage`, `custom_domains`, `storage_gb`, `seats`. Non-negative integers, or `null` for unlimited (allowed for custom plans) |
| `plans[].topups` | Whether top-ups can be bought on this plan |
| `plans[].support` | `github_issues`, `email` or `priority_email`. Shown in `GET /v1/plans` |
| `plans[].stripe_price_id` | Required for a paid plan when `PM_BILLING=stripe`. `null` means the plan cannot be bought through Checkout (it can still be given with `PATCH …/billing`) |
| `topup.units` | Exactly `inboxes`, `sends` and `triage`. Custom domains, storage and seats have no top-up (PRD §13) |
| `topup.stripe_price_ids` | One monthly price per top-up feature, each priced at `topup.price` per unit |

`GET /v1/plans` and the `plans` array of `GET /v1/usage` expose each plan as `plan_id`, `name`, `price`,
`currency`, `interval`, `included`, `topups` and `support`. Stripe price IDs are never returned.

**Validation.** `pmail deploy` parses the catalog and refuses to upload an invalid one. At runtime the
Worker parses it once per isolate. If it is invalid anyway, the Worker logs `plan_catalog_invalid`, raises a
state alert, and uses the built-in catalog, so limits stay enforced and mail keeps flowing; Checkout is then
unavailable because the built-in catalog has no price IDs.

**Catalog changes.** `TenantQuota` stores the SHA-256 of the catalog it last applied (storage key
`catalog_hash`). On the first request after a deploy whose catalog hash differs, it recomputes `granted`
for every feature from the new catalog. `used` is not touched.

## Allowances and periods

`granted` for a feature is the plan's `included` value plus, for `inboxes`, `sends` and `triage`, the
active top-up units times `topup.units` (FR-BILL-2). It is `NULL` for `exempt` and `disabled` workspaces,
and for a plan whose `included` value is `null`.

| Feature | Kind | `used` means | Resets |
|---|---|---|---|
| `sends` | Monthly | Recipients accepted by the transport this period | At each period start |
| `triage` | Monthly | Analyses stored this period | At each period start |
| `inboxes` | Count | Identities with status `active` or `paused` | Never |
| `custom_domains` | Count | Domains of kind `zone`, `delegated` or `external` (every kind except `platform`, whatever the connection method) not yet `removed` | Never |
| `seats` | Count | Members plus pending, unexpired invitations | Never |
| `storage_gb` | Measured | Stored bytes, in GB (2^30 bytes) rounded up | Never (refreshed hourly) |

Monthly features reset at the start of each billing period; counts do not (FR-BILL-3). The period comes
from one of two sources:

| Workspace | Period |
|---|---|
| Has an active plan subscription in Stripe | The subscription item's `current_period_start` and `current_period_end` (since Stripe API version `2025-03-31.basil`, the version every request pins, these are on subscription items, not on the subscription) |
| No subscription (Free, a complimentary plan, `exempt`, `disabled`) | Calendar months in UTC, starting 00:00 on the 1st |

Starting or ending a subscription starts a new period at that moment, so `sends` and `triage` start again
from zero. The new period ends at the subscription's period end, or at the next 1st of the month for a
workspace that just left a subscription. `billing_accounts.period_start` and `period_end` mirror the
current period, and `allowances.resets_at` holds `period_end` for the two monthly features.

**Plan changes within a period.** A change of plan or top-ups rewrites `granted` immediately and keeps
`used`. After a downgrade, `used` can exceed `granted`: `remaining` is then `0`, and new metered actions
of that feature are refused until the next reset (monthly) or until the count falls (counts). Nothing is
deleted (FR-BILL-9, [W11]).

**Which plan applies.** `billing_accounts.plan_id` always names the plan whose allowances apply:

| Stripe subscription status | Allowances |
|---|---|
| `active`, `trialing` | The subscribed plan |
| `past_due`, `unpaid` | The subscribed plan until `grace_until`, then the default plan ([Grace](#grace)) |
| `incomplete` (first payment not made) | The default plan until the first invoice is paid |
| `incomplete_expired`, `paused`, `canceled`, or no subscription | The default plan, or a complimentary plan set by the operator |

## TenantQuota allowances and holds

`TenantQuota` already keeps daily counters and abuse windows ([Outbound](outbound.md#tenantquota)). This
design adds the `allowances` and `holds` tables from the
[data model](data-model.md#3-other-durable-objects) and these requests:

```rust
// Declared in crates/worker/src/quota/mod.rs by the M5 stub, with the types they carry (Feature,
// BillingMode, Allowances, and the Held and Denied answers), so the stub compiles and answers every
// variant; crates/worker/src/billing/quota.rs implements their behaviour in M22 without changing them.
pub enum Feature { Inboxes, Sends, Triage, CustomDomains, StorageGb, Seats }

Hold     { feature: Feature, units: u32, r#ref: String, gates: Vec<Feature> },
         // → Held { hold_id, remaining } | Denied { feature, granted, used, resets_at, first_in_period }
Settle   { feature: Feature, r#ref: String, consume: u32, keep: u32 },
         // consume + keep ≤ held units; `keep` stays held (a deferred SMTP retry); the rest is released
Extend   { feature: Feature, r#ref: String, until: i64 },     // a send waiting in transport backoff
Adjust   { feature: Feature, delta: i64, r#ref: String },     // a count went down: identity deleted, …
SetPlan  { mode: BillingMode, granted: Allowances, period_start: i64, period_end: i64, catalog_hash: String },
SetMeasured { storage_bytes: u64 },                            // hourly roll-up
Reconcile { inboxes: u32, custom_domains: u32, seats: u32, read_at: i64 },
GetUsage,                                                      // → every allowance row
```

The caller sends them in the usual `RpcEnvelope` with the tenant ID, which the object checks against its
stored owner (section 5 of the design conventions, "Internal Durable Object RPC").

### Hold

Inside one `transaction_sync`:

```sql
-- ?1 feature, ?2 units, ?3 ref, ?4 now
SELECT granted, used, held FROM allowances WHERE feature = ?1;
-- Denied when granted IS NOT NULL AND used + held + ?2 > granted.
-- Each feature in `gates` is also checked: storage_gb denies when granted IS NOT NULL AND used > granted.
INSERT INTO holds (id, feature, units, ref, expires_at)
VALUES (?hld, ?1, ?2, ?3, ?4 + 600000)
ON CONFLICT (feature, ref) DO NOTHING;
-- Only when the INSERT added a row; an open hold for this ref is reused, never doubled:
UPDATE allowances SET held = held + ?2 WHERE feature = ?1;
```

- The `UNIQUE (feature, ref)` constraint makes a hold idempotent per reference. A redelivered triage job
  or a retried create reuses the open hold instead of taking a second one.
- `remaining` is `max(0, granted − used − held)`. It is what `GET /v1/usage` reports, so an agent sees what
  it can actually use while other requests are in flight.
- A denial writes nothing in the object except, the first time in a period, the storage key
  `limit_reached:{feature}:{period_start}`; it then returns `first_in_period: true` and the caller emits
  `billing.limit_reached` ([Events](#events-and-errors)).
- Requests to one Durable Object are processed one at a time, and the transaction contains no `.await`.
  When two sends race for the last unit, exactly one hold succeeds and the other is denied ([W1]).

### Usage thresholds

When consumed units first take `used` to or past 80% or 100% of `granted` (top-ups included), that is,
a `Settle` that consumes units, the settle of a count feature's hold when its create commits, or
`SetMeasured` for storage, `TenantQuota` sends
`NotifierRequest::UsageThreshold { feature, threshold, used, granted, period }` to the tenant's
`Notifier` (`tenants.notify_do_id`) after its transaction commits, and records the meta key
`alerted:{feature}:{threshold}:{period}` in the same transaction that decides it:

- `sends` and `triage` (they reset): `{period}` is the period's `period_start` and the value `1`; a
  threshold already recorded for the period sends nothing more, even if holds are released and the usage
  crosses again ([O20](../edge-cases.md)). The monthly reset starts a new `period_start`, so the next
  period alerts again.
- `inboxes`, `custom_domains`, `seats` and `storage_gb` (counts): `{period}` is `count` and the value is
  the time of the last alert. A threshold alerts when it is crossed upwards and at least 24 hours have
  passed since that value ([O21](../edge-cases.md)). For `storage_gb` the crossing is detected by
  `SetMeasured`.
- `granted` `NULL` (exempt, or billing `disabled`) sends nothing. With `PM_BILLING=off` no usage alert is
  ever sent: no feature has a limit to reach, and tenant policy has no quota for the six allowances
  ([O23](../edge-cases.md)). The daily caps are not allowances; the identity and tenant send caps keep their `quota.warning` events
  (the agentic-search cap has none).

The call is fire-and-forget after commit: a lost call loses one email, never a hold or a count, and the
`quota.warning` and `billing.limit_reached` webhook events are unchanged.

### Settle, extend and expiry

- **Settle** deletes the hold, subtracts its units from `held`, and adds `consume` to `used`. A release is
  a settle with `consume: 0`. With `keep > 0` (an SMTP relay deferred some recipients with `4xx`), the hold
  is not deleted: its `units` become `keep`, `expires_at` moves to the retry time plus 10 minutes, and only
  `units − keep` leave `held`. It is a re-hold of units already held, so it is never denied.
- **Settle without a hold.** If no hold matches the reference (it expired, or it was released when a send
  became `uncertain`), `consume` is added to `used` directly. The action already happened, so it is
  counted even if `used` passes `granted`. This is how a reconciled uncertain send is charged
  (FR-BILL-5, [W5]). The metric `quota_consumed_without_hold_total` counts it.
- **Expiry.** Every hold expires 10 minutes after it was created or last extended (FR-BILL-4). The object
  keeps the earliest `expires_at` as its pending wake-up `alarm:holds` and the alarm releases due holds
  ([W6]). Each expiry increments `quota_hold_expired_total`, because it means a request died without
  settling.
- **Extend.** A send that is waiting in transport backoff ([G3](../edge-cases.md)) is still pending, so
  its hold must outlive the wait. Each time the `pm-outbound` consumer re-queues a message with a delay,
  it first calls `Extend` with `until = retry_at + 10 minutes`. If the Worker dies, the hold still expires
  10 minutes after the retry was due.
- **Counts after an expired hold.** When a hold on a count feature (`inboxes`, `custom_domains`, `seats`)
  expires, the create may or may not have committed in D1. The object marks the feature `stale`, and the
  next `Hold` on it is preceded by a recount from D1 (the same queries as
  [Reconciliation](#reconciliation-against-d1)). This keeps NFR-BILL-1 exact after a crash.

### Monthly reset

The object's wake-up `alarm:reset` is the earliest `resets_at`. At that time it sets `used = 0` for `sends`
and `triage`, moves `period_start` to the old `period_end`, and sets a provisional `period_end` one calendar
month later. `SetPlan` from the billing webhook then confirms or corrects the period. A `SetPlan` whose
`period_start` equals the stored one does not reset again, which is the normal case at a Stripe renewal
(the new period starts exactly where the old one ended). A `SetPlan` with a later `period_start` resets.

### Storage

Storage is not held: it grows with inbound mail, which is never refused. It acts as a **gate** instead
(FR-BILL-8). `Hold` for `inboxes` and `custom_domains`, and for `sends` when the message carries
attachments, passes `gates: [StorageGb]`. While storage is over its allowance, those holds are denied with
`feature: storage_gb`.

The hourly usage roll-up (below) computes stored bytes per workspace as the sum, over its identities, of
what each `IdentityMailbox` reports: `messages.raw_size` for messages whose raw MIME is still stored
(`raw_r2_key` not null, so retention purges lower it), `attachments.size`, and its own SQLite size
(`page_count × page_size`). Messages with status `throttled` or `hidden` and their attachments are left
out of the first two sums, so a flood of unsolicited mail cannot push a workspace over its storage
allowance and block its sends ([Inbound › Inbound volume caps](inbound.md#inbound-volume-caps-d5-d13),
[D13](../edge-cases.md)). It calls `SetMeasured`, which sets `storage_gb.used = ceil(bytes / 2^30)`, and
writes `usage_daily.storage_bytes`.

### Reconciliation against D1

Counts can drift from D1 if a settle is lost. D1 is the source of truth, so the roll-up corrects them:

```sql
SELECT COUNT(*) FROM identities WHERE tenant_id = ?1 AND status IN ('active','paused');
SELECT COUNT(*) FROM domains    WHERE tenant_id = ?1 AND kind IN ('zone','delegated','external') AND state <> 'removed';
SELECT (SELECT COUNT(*) FROM members WHERE tenant_id = ?1)
     + (SELECT COUNT(*) FROM invitations WHERE tenant_id = ?1 AND status = 'pending' AND expires_at > ?2);
```

`Reconcile` sets `used` to each count, except for a feature that has an open hold (a create is in
flight, so the D1 count may not include it yet); that feature waits for the next round. A difference
increments `quota_count_drift_total{feature}`. The first reconciliation after billing is turned on also
seeds the counts, so no backfill script is needed.

**Schedule.** The `*/15` cron's usage roll-up ([Configuration](../../reference/configuration.md#bindings))
processes each workspace at most once an hour: storage, count reconciliation, invitation expiry (pending
invitations past `expires_at` become `expired` and release their seat) and the flush of daily counters to
`usage_daily`.

## What the Worker meters

Every metered action takes a hold before it runs and settles it when the outcome is known (FR-BILL-4). A
table test lists each row; a metered action without a row fails CI (build plan M22).

| Feature | Unit | Hold taken | Settled | Count goes down |
|---|---|---|---|---|
| `inboxes` | One identity | `POST /v1/tenants/{id}/identities` (and the console's create form), after body validation and the `client_id` replay check, before the D1 batch ([Identities › Create](identity-domains.md#create) step 6). `ref` = the new `idn_` ID. Gate: `storage_gb` | Consumed when the D1 batch commits. Released when the request fails (`username_taken`, `address_taken`, `domain_not_ready`, D1 error) | Identity delete moves it to `deleting`: `Adjust −1` |
| `sends` | One recipient (FR-BILL-5) | `IdentityMailbox.submit`, after the idempotency lookup, the in-flight check and policy steps 1–17, together with the daily-cap reserve of step 18 ([Outbound › Policy pipeline](outbound.md#policy-pipeline)). `units` = recipients left after the per-recipient filters of step 16; a send whose recipients are all suppressed takes no hold. `ref` = the new `msg_` ID. Gate: `storage_gb` when the message has attachments | At `RecordTransportOutcome`: consume one unit per recipient the transport accepted (`submitted`). Release for `rejected`, `failed` and `canceled`, for recipients refused by the provider's suppression ([G4](../edge-cases.md)), when the thread lock fails at step 19, and when the outcome is `uncertain`. A reconciled uncertain send, or one resolved with `{"outcome":"sent"}`, consumes then without a hold ([W5]) | Never (monthly) |
| `triage` | One stored analysis | The triage consumer, at the start of each attempt, `ref` = message ID ([Triage › Metering](triage.md#12-metering)). Quarantined mail takes its hold only when released (FR-BILL-7) | Consumed when the commit stores `done`; released for `failed`, a no-op commit, or a transient error before a retry | Never (monthly) |
| `custom_domains` | One domain of kind `zone`, `delegated` or `external` | `POST /v1/tenants/{id}/domains` (and the console), after validation and the `domain_exists` check, before any provider call ([Adding a domain](identity-domains.md#adding-a-domain)). `ref` = the `dom_` ID. Gate: `storage_gb` | Consumed when the D1 row is written. Released on any failure (`502 upstream_error`, `409 existing_mx`, …) | The `domain_remove` job's `finish` step sets `removed`: `Adjust −1` ([Domain removal](identity-domains.md#domain-removal)) |
| `storage_gb` | GB stored, rounded up | No hold: a gate on the three rows above | `used` is set by the hourly roll-up | As measured |
| `seats` | One member or pending invitation | `POST /v1/tenants/{id}/invitations` and the console's invite form, before the `INSERT INTO invitations`. `ref` = the `inv_` ID ([Console › Invitations](console.md#invitations)) | Consumed when the invitation row is inserted. Released if the insert fails (an invitation for that address is already pending) | Invitation revoked or expired: `Adjust −1`. Member removed: `Adjust −1`. An accepted invitation turns into a member and keeps its seat |

Not metered against a plan: inbound mail (never refused, FR-BILL-8), search, agentic search, agent
assertions and signed HTTP requests (they are counted in `usage_daily` as `assertions` and
`http_signatures`, through `RecordUsage`, and limited only by `RL_SIGN`), and notification email. Agentic
search is bounded by the per-key rate limit and the tenant's daily `agentic_daily_cap`
([Search](search.md)), not by an allowance (PRD §13).

The default tenant's own mail (sign-in codes, invitations) is not metered. `pmail setup` creates the
default tenant with billing `disabled` ([CLI and setup](cli.md)), and it must stay `disabled` or `exempt`.

## Ordering relative to idempotency

FR-BILL-6 requires the `402` to come before any idempotency record, so a denied request leaves nothing
behind and a retry with the same key is evaluated again.

**Sends** (`IdentityMailbox.submit`, [Outbound › Reservation](outbound.md#reservation-inside-the-mailbox-fr-out-1-g1)):

```text
1. idempotency lookup (read only)      same key + same body → stored response, no hold   (W4)
                                       same key + other body → 409 idempotency_conflict
2. in-flight check                      → 409 request_in_progress
3. policy steps 1–17
4. TenantQuota: Hold(sends) + daily-cap Reserve, one request, one transaction
                                       allowance spent → 402 billing_limit; nothing written (W3)
                                       daily cap reached → 429 daily_cap_reached; nothing written
5. thread lock                          failure → Release + Release(daily cap) → 409 thread_busy
6. TRANSACTION { message queued, deliveries, idempotency row, lock } → 202
```

The allowance is checked before the daily caps, so a request that would fail both gets the `402`, which
needs a person, rather than a `429` that would only make the agent wait. If either check fails, neither
the hold nor the daily reservation is kept.

**Other metered `POST`s** (identity create, domain add, invitation create), where `Idempotency-Key` is
optional and recorded in D1 `idempotency_records`:

```text
1. idempotency lookup (read only)      completed record → stored response, no hold
2. client_id replay (identities only)  existing identity → 200, no hold
3. Hold                                 denied → 402 billing_limit; nothing written
4. INSERT idempotency_records (in_progress)   conflict → 409 request_in_progress, Release
5. the action; Settle; complete the idempotency record
```

The `402` body follows the [error envelope](../../reference/errors.md) with `retryable: false` and
`details` = `feature`, `granted`, `used`, `resets_at` (`null` for counts) and `upgrade_url`
(`https://{PM_CONSOLE_HOST}/console/plan`, or `null` when `PM_CONSOLE=off`). The `fix` says to upgrade or add a
top-up and retry with the same key.

## Stripe integration

Stripe is called for five things only ([Architecture › Console and billing](../architecture.md#console-and-billing)):

| Call | When |
|---|---|
| Create a Checkout Session | [Checkout](#checkout) |
| Retrieve a Checkout Session (`GET /v1/checkout/sessions/{id}`) | The return page ([Cloud sign-up › Coming back from Checkout](cloud-signup.md#9-coming-back-from-checkout)) |
| Create a Customer Portal session | [Customer Portal](#customer-portal) |
| Read subscriptions (`GET /v1/subscriptions?customer=…`) | When a webhook arrives ([Applying state](#applying-state)), and before cancelling |
| Cancel subscriptions (`DELETE /v1/subscriptions/{id}`, at once, with no proration and no refund) | Workspace deletion ([Privacy › Tenant scope](privacy.md#66-tenant-scope), step `cancel_billing`), and the webhook handler when a live subscription appears for an erasing or erased workspace (`cancelled_after_erasure`, [Webhook endpoint](#webhook-endpoint)) |

Its signed webhooks are the only writer of subscription state in D1 (FR-BILL-10). `PM_STRIPE_SECRET_KEY` is a
restricted key with exactly these permissions: create and retrieve Checkout Sessions, create Customer
Portal sessions, read subscriptions, and cancel subscriptions. Every request pins the API version in
`Stripe-Version: 2025-03-31.basil`, because periods are read from subscription items, and the event
destination is pinned to the same version.

### Stripe objects

| Object | One per | Created by | Stored in |
|---|---|---|---|
| Customer | Workspace | The first Checkout Session (`subscription` mode creates one when none is given) | `billing_accounts.stripe_customer_id` |
| Plan subscription | Workspace | Checkout, with one line item: the plan's price, quantity 1 | `billing_accounts.stripe_subscription_id` |
| Top-up subscription | Workspace and top-up feature (at most three) | Checkout, with one line item: the feature's top-up price, quantity = units | Units summed into `billing_accounts.topups_json` |

Plan and top-ups live in separate subscriptions on purpose. The Customer Portal can cancel a subscription
with several products but cannot update one, and a Checkout Session in `subscription` mode creates a new
subscription rather than changing an existing one. With one
product per subscription, the Portal can switch the plan subscription between plan prices and change a
top-up subscription's quantity, and the Worker's only write to a subscription is cancelling it when the
workspace is deleted. Every
subscription carries `metadata.tenant_id` and `metadata.kind` (`plan` or `topup:{feature}`), set through
`subscription_data.metadata` at Checkout.

A paid top-up keeps counting while its subscription is active, even if the plan no longer allows buying
top-ups (for example after a downgrade to Free); the console's plan page then suggests cancelling it.

### Checkout

`POST /console/plan/checkout` (owner only, re-authenticated, audit `billing.checkout_started`;
[Console › Roles](console.md#roles)) creates a session and answers `303` to its `url`:

| Parameter | Value |
|---|---|
| `mode` | `subscription` |
| `line_items[0]` | `price` = the plan's `stripe_price_id` and `quantity` 1; or a top-up price with the chosen quantity |
| `customer` | `stripe_customer_id` when set; otherwise `customer_email` = the owner's sign-in address |
| `client_reference_id` | The tenant ID |
| `metadata[tenant_id]`, `subscription_data[metadata][tenant_id]`, `subscription_data[metadata][kind]` | As above |
| `automatic_tax[enabled]` | `true` (Stripe Tax). With an existing customer, `customer_update[address]=auto`, so the address entered on the page is the one taxed |
| `tax_id_collection[enabled]` | `true`, so a business can enter its VAT number |
| `success_url` | `https://{PM_CONSOLE_HOST}/console/plan/return?session_id={CHECKOUT_SESSION_ID}` |
| `cancel_url` | `https://{PM_CONSOLE_HOST}/console/plan`, or `https://{PM_CONSOLE_HOST}/console?upgrade={plan}` (the Overview; `{plan}` is the `plan_id`) when Checkout was started from sign-up, so the Overview can show "Finish upgrading to {plan name}" without stored state ([Cloud sign-up › Open sign-up](cloud-signup.md#62-after-launch-open-sign-up), [W24](../edge-cases.md)) |

The session expires after Stripe's default of 24 hours. The console refuses a plan Checkout when a plan
subscription already exists (the Portal changes plans), and a top-up Checkout when the plan does not allow
top-ups or a top-up subscription for that feature exists (the Portal changes its quantity). Returning to
`success_url` changes nothing by itself: the plan changes when the webhook arrives, usually within
seconds. The return page retrieves the session, checks that its `client_reference_id` and
`metadata.tenant_id` are this workspace (and its customer, when `stripe_customer_id` is already set), and
waits for the webhook without JavaScript ([Cloud sign-up › Coming back from Checkout](cloud-signup.md#9-coming-back-from-checkout)).

### Customer Portal

`POST /console/plan/portal` (owner only, re-authenticated, audit `billing.portal_opened`) creates a portal
session (`POST /v1/billing_portal/sessions` with `customer` and `return_url` = `https://{PM_CONSOLE_HOST}/console/plan`)
and answers `303` to its `url`. A portal session expires 5 minutes after creation if unused, so the console
creates a new one on every click and never stores the URL. Buttons for one task deep-link with
`flow_data[type]`: `subscription_update` (switch plan, or change a top-up quantity), `subscription_cancel`
and `payment_method_update`.

The portal configuration is part of the Stripe account setup: switching plans between the plan prices,
quantity changes for top-up prices, prorations on, cancellation at the end of the period, payment methods,
invoice history and tax IDs. The Worker treats a plan subscription's quantity as 1 whatever the Portal
allows.

### Webhook endpoint

`POST /billing/stripe/webhook` exists only when `PM_BILLING=stripe`. It is authenticated by the Stripe
signature, not by an API key, and lives in its own route table outside the API key router
([Security › Unauthenticated routes](security.md#47-unauthenticated-routes)). The steps, in order:

1. **Body.** Read the raw bytes, at most 1 MiB (`413 payload_too_large` otherwise). Never re-serialise
   before verifying.
2. **Signature** ([W14]). Split `Stripe-Signature` on `,` and each element on the first `=`. Take `t` and
   every `v1` value; ignore `v0` and any other scheme (Stripe asks for this, to prevent downgrade attacks).
   Compute hex `HMAC-SHA256(PM_STRIPE_WEBHOOK_SECRET, t + "." + raw body)` and compare it in constant time
   with each `v1`. Accept on any match, and only when `|now − t| ≤ 300` seconds. During a secret roll, Stripe
   signs with every active secret for up to 24 hours, so updating the Worker secret inside that window
   loses nothing. A failure returns `400 invalid_request`, logs `stripe_signature_invalid` with the
   request's IP hash, and increments `stripe_webhook_rejected_total`; nothing else is read.
3. **Deduplicate.** `INSERT OR IGNORE INTO billing_events (id, type, received_at)` with the Stripe event
   ID. A row with `processed_at` set means a duplicate: answer `200` at once. A row without it is an
   attempt that failed half-way and is processed again, which is safe because processing re-reads state.
4. **Resolve the workspace.** `checkout.session.completed`: `client_reference_id`. Other events: look up
   `billing_accounts.stripe_customer_id`; if the customer is not known yet (events arrive in any order),
   use the subscription's `metadata.tenant_id`. The tenant must exist and be `metered`. If the workspace
   already has a different customer ID, the outcome is `error:customer_mismatch` and an alert fires.
   `billing_events.tenant_id` is set. A tenant that is `erasing` or `erased` is not an error: workspace
   deletion cancels its subscriptions ([Privacy › Tenant scope](privacy.md#66-tenant-scope), step
   `cancel_billing`), and the events that follow (`customer.subscription.deleted`, a final invoice) are
   answered `200` and recorded with outcome `ignored_erased`. Nothing is applied, and no alert fires.
   One exception closes a race: a subscription can be created after `cancel_billing` ran, when the owner
   deletes the workspace between paying at Checkout and the first webhook (the customer ID was not linked
   yet, so `cancel_billing` found nothing). When the event is `checkout.session.completed` with a
   subscription, or `customer.subscription.created` or `.updated` whose subscription is not `canceled`, the
   handler cancels that subscription at once (`DELETE /v1/subscriptions/{id}`, no proration, no final
   invoice), records outcome `cancelled_after_erasure` and fires `billing_cancelled_after_erasure`. A failed
   cancel answers `500`, so Stripe retries the event.
5. **Re-read and apply** ([Applying state](#applying-state)).
6. Set `processed_at` and `outcome`, and answer `200`.

`billing_events` is read in two more places: the `stripe_webhook_errors` alert counts rows whose
`outcome` starts with `error:` in the last hour (by `received_at`, with the `type` in the alert detail),
and the global retention job deletes rows whose `received_at` is older than 400 days.

A Stripe read that fails, or a D1 error, answers `500`, and Stripe retries (for up to three days in live
mode). Processing has a 10-second deadline. Event types outside the table below are answered `200` and
recorded with outcome `error:unhandled_type`, so a misconfigured endpoint shows up in the metrics.

### Events handled

| Stripe event | Why it matters | Action |
|---|---|---|
| `checkout.session.completed` | A plan or top-up was bought | Link `stripe_customer_id` to the workspace if unset; re-read |
| `customer.subscription.created` | A subscription exists (may arrive before the Checkout event) | Re-read |
| `customer.subscription.updated` | Plan switch, quantity change, renewal (new period), `cancel_at_period_end`, status change | Re-read |
| `customer.subscription.deleted` | A subscription ended | Re-read |
| `invoice.paid` | A payment succeeded; a `past_due` subscription can become `active` again | Re-read |
| `invoice.payment_failed` | A payment failed; the subscription becomes `past_due` (or stays `incomplete` on a first invoice) | Re-read |

Every action is the same re-read. The event only says *that* something changed; Stripe's current state
says *what* is true now. This makes duplicates, late events and reordering harmless ([W12]).

### Applying state

1. Record `read_started_at = now`.
2. `GET /v1/subscriptions?customer={stripe_customer_id}` with the default status filter, which returns
   every subscription that is not canceled (pages of 100).
3. Derive:
   - **plan subscription**: the subscription whose item price is a plan's `stripe_price_id`. If there are
     two, the newest wins, the console shows the conflict, and `billing_plan_conflict` is logged;
   - **status**: Stripe's status mapped onto `billing_accounts.status`: `active` and `trialing` as they
     are, `past_due` and `unpaid` → `past_due`, `incomplete` → `incomplete`; `incomplete_expired`,
     `paused` or no plan subscription → `canceled`, or `active` when the workspace never had one. The
     column keeps these five values;
   - **period**: the plan subscription item's `current_period_start` and `current_period_end`; calendar
     months without a subscription ([Allowances and periods](#allowances-and-periods));
   - **`cancel_at_period_end`**: copied;
   - **top-ups**: for each feature, the quantity on its top-up subscription when that subscription is
     `active` or `trialing`, or `past_due`/`unpaid` while the workspace is within its grace period;
   - **`plan_id`**: the subscribed plan when its status grants it (table in
     [Allowances and periods](#allowances-and-periods)), otherwise `default_plan`.
4. Write in one D1 batch, guarded so an older read never overwrites a newer one:

   ```sql
   UPDATE billing_accounts
   SET plan_id = ?2, status = ?3, topups_json = ?4, period_start = ?5, period_end = ?6,
       grace_until = ?7, stripe_customer_id = ?8, stripe_subscription_id = ?9,
       cancel_at_period_end = ?10, updated_at = ?11          -- ?11 = read_started_at
   WHERE tenant_id = ?1 AND updated_at < ?11;
   ```

   plus the `event_index` rows for any `billing.*` events and an `audit_log` row. When the new `plan_id`
   is a paid plan (any plan other than `default_plan`), the batch also runs
   `UPDATE tenants SET ramp_lifted_at = ?now WHERE id = ?1 AND ramp_lifted_at IS NULL`, which ends the
   new-workspace send ramp at once and keeps it ended after a later downgrade
   ([Cloud sign-up › Abuse and safety](cloud-signup.md#10-abuse-and-safety-on-cloud), [W30](../edge-cases.md)).
   If the `UPDATE` of `billing_accounts` changed no row, a newer read has already been applied: the
   outcome is `ignored_stale`.
5. Send `SetPlan` to `TenantQuota` with the new `granted` values and period. If it fails, the event is
   answered `500` and retried; `SetPlan` is idempotent.
6. When the status became `past_due` in this batch (the `billing.payment_failed` row below), send the
   owner's `account` email: `NotifierRequest::Account { user_id: <the owner's usr_ ID>, event: payment_failed }`,
   after the batch commits, on the Notifier chosen by the rule in
   [Notifications § 3](notifications.md#3-how-notifications-are-produced). It is fire-and-forget like
   every Notifier call: a lost call loses one email, never a state change. A redelivered event finds the
   status already `past_due` and sends nothing.

Events emitted by this step (as platform events, [Events](#events-and-errors)):

| Change | Event |
|---|---|
| `plan_id` changed after `checkout.session.completed` | `billing.plan_changed`, reason `checkout` |
| `plan_id` changed because a subscription ended | `billing.plan_changed`, reason `canceled` |
| `plan_id` restored by a late payment after the grace period ended | `billing.plan_changed`, reason `payment_recovered` |
| `plan_id` changed for any other Stripe reason (a plan switch in the Portal) | `billing.plan_changed`, reason `portal` |
| Status became `past_due` | `billing.payment_failed` with `grace_until` |

### Grace

FR-BILL-10 and [W13]: a failed payment keeps the plan for a grace period, then applies the default plan's
limits.

- When the status first becomes `past_due`, `grace_until = now + PM_BILLING_GRACE_DAYS × 24 h` (7 days by
  default). Later failures in the same episode do not move it. `billing.payment_failed` is emitted and the
  console shows a banner to every member with a link to the Portal for the owner.
- The `*/15` cron selects `billing_accounts` rows with `status = 'past_due'`, `grace_until <= now` and a
  `plan_id` other than `default_plan`. For each it sets `plan_id = default_plan`, emits
  `billing.plan_changed` with reason `payment_failed_grace_ended`, and sends `SetPlan`. Nothing is deleted:
  counts above the new allowances behave as after any downgrade ([W11]).
- When Stripe reports the subscription `active` again, the re-read clears `grace_until`. If the grace
  period had already ended, it also restores the plan and emits `billing.plan_changed` with reason
  `payment_recovered`.
- If Stripe gives up and cancels the subscription, `customer.subscription.deleted` applies the default plan
  for good, with reason `canceled`.

## Failure modes

Mail must not depend on Stripe. Each dependency fails open or closed for a stated reason:

| What fails | Effect | Open or closed | Why |
|---|---|---|---|
| Stripe API unreachable when an agent sends | Nothing: sends, triage and creates use only `TenantQuota` ([W2]) | Open (not in the path) | NFR-BILL-2: Stripe is needed only to change plans |
| Stripe API unreachable when the owner clicks Upgrade or Manage billing | The console shows "Stripe did not answer; try again in a minute" (`502 upstream_error`, retryable) | Closed for that click only | There is nothing to buy without Stripe, and no state changes |
| Stripe webhooks delayed | The workspace keeps its last known plan until the event arrives (Stripe retries for up to three days) | Open (last known state) | Stripe is the source of truth; guessing a change would be worse than waiting |
| Stripe read fails while processing a webhook | `500` to Stripe, which retries | Closed for that event | Deduplication and the re-read make the retry safe |
| A webhook fails signature verification | `400`; nothing applied | Closed | A forged event must never change a plan ([W14]) |
| `TenantQuota` unavailable (overloaded, deadline) | The metered request returns `503 unavailable` (retryable) and stores nothing; a triage job is retried later, not skipped | Closed | An unchecked action could exceed the allowance (NFR-BILL-1); it is the same platform the mailbox runs on, and a retry with the same key is safe |
| `TenantQuota` unavailable when mail arrives | Nothing: inbound acceptance never calls it; counters are flushed later | Open | FR-BILL-8 |
| Invalid `PM_PLAN_CATALOG` | Built-in catalog plus an alert | Open (with the default limits) | Mail must keep flowing; limits stay enforced |

**Contrast with goshen-email.** goshen asks Autumn, a third-party billing service, before each metered
action, and fails closed: when Autumn does not answer, metered operations return `503 billing_unavailable`
and nothing is written. Pylota Mail keeps balances in its own Durable Object, so a Stripe outage changes
nothing for agents. The only closed failure is its own `TenantQuota`, which is no less available than the
mailbox the action needs anyway.

## Self-host mode

`PM_BILLING=off` is the default for self-hosting (FR-BILL-12, [W19]):

- No plan checks. Holds succeed and only count. The daily caps in tenant policy
  (`identity_daily_send_cap`, `tenant_daily_send_cap`, `search.agentic_daily_cap`) still apply and return
  `429 daily_cap_reached` or `429 agentic_budget_exhausted`.
- `GET /v1/usage` reports `"billing": "disabled"` and each feature with `granted: null`,
  `remaining: null`, `unlimited: true` and the real `used`.
- No usage alerts are sent ([Usage thresholds](#usage-thresholds), [O23](../edge-cases.md)).
- `GET /v1/plans` returns `{ "billing_enabled": false, "data": [] }`.
- `/billing/stripe/webhook`, `/console/plan/checkout` and `/console/plan/portal` are not registered
  (`404`). The console's plan page shows usage only.
- No Stripe account or Stripe secret is needed; `pmail setup` does not ask for one.

Turning billing on is an operator choice: set `PM_BILLING=stripe`, `PM_PLAN_CATALOG` with price IDs, and
both Stripe secrets, then redeploy. Existing workspaces keep their stored mode until a platform key
changes it with `PATCH /v1/tenants/{id}/billing`. FSL-1.1-ALv2 does not permit offering the software to
others as a competing commercial service ([PRD §12](../prd.md#12-licensing)), so check the licence before
charging others for a deployment.

## Events and errors

`billing.*` and `member.*` events have no owner Durable Object. They are written to `event_index` with
`owner_kind = 'platform'`, `owner_id = 'platform'`, the workspace's `tenant_id` and the envelope in
`payload_json`, in the same D1 batch as the change, and fanned out like `webhook.disabled`
([Webhooks › Platform events](webhooks.md#platform-events)). Tenant endpoints receive them because
`tenant_id` is set.

| Event | When | `data` |
|---|---|---|
| `billing.plan_changed` | `plan_id` changed | `from_plan`, `to_plan`, `reason` (`checkout`, `portal`, `payment_failed_grace_ended`, `payment_recovered`, `canceled`, `operator`) |
| `billing.payment_failed` | Status became `past_due` | `grace_until` |
| `billing.limit_reached` | The first `402` for a feature in a period | `feature`, `granted`, `resets_at` |

| Error | When |
|---|---|
| `402 billing_limit` | A hold was denied. Never for inbound mail, and never for the replay of a completed request |
| `409 plan_managed_by_stripe` | `PATCH /v1/tenants/{id}/billing` with `plan_id` on a workspace with a Stripe plan subscription: the handler reads `billing_accounts.stripe_subscription_id` and refuses when it is not `NULL` |
| `503 unavailable` | `TenantQuota` did not answer in time |

Audit actions: `billing.checkout_started`, `billing.portal_opened`, `billing.mode_change`,
`billing.plan_set` (operator), and `billing.plan_changed` (written by the webhook with the Stripe event ID
in `details_json`).

Metrics: `quota_hold_denied_total{feature}`, `quota_hold_expired_total{feature}`,
`quota_consumed_without_hold_total`, `quota_count_drift_total{feature}`, `stripe_webhook_total{type,outcome}`,
`stripe_webhook_rejected_total`, `stripe_api_errors_total{call}`.

## Open points

1. **Closed: plan restored after a late payment.** `billing.plan_changed` has the reason
   `payment_recovered` ([Webhook events](../../reference/events.md#workspaces-members-and-billing)).
2. **Closed: Stripe statuses outside the column.** `billing_accounts.status` keeps its five values;
   [Applying state](#applying-state) maps `unpaid` to `past_due`, and `incomplete_expired` and `paused`
   to `canceled`.
3. **Closed: hold expiry after an extension.** The data model now describes `holds.expires_at` as
   "created or last extended + 10 minutes".
4. **Closed: the send path.** [Outbound › Policy pipeline](outbound.md#policy-pipeline) shows it: the
   `sends` hold comes before the daily-cap reserve in step 18, and `QuotaRequest` has `Hold`, `Settle`
   and `Extend`.

## Tests

| Test | Proves | Covers |
|---|---|---|
| `core::billing::catalog_parse` | The built-in catalog equals PRD §13; invalid catalogs (unknown version, missing feature, paid plan without price ID under `stripe`, top-up keys other than the three) are refused | FR-BILL-2 |
| `it::billing::metering_points` (table test) | Every row of [What the Worker meters](#what-the-worker-meters) takes a hold and settles it on every exit path; a new metered handler without a row fails | FR-BILL-4, M22 |
| `it::billing::w1_last_unit_race` | Two concurrent sends for the last unit: exactly one `202`, one `402` | [W1], NFR-BILL-1 |
| `it::billing::w2_stripe_down_sends_ok` | With the Stripe fake refusing connections, sends, triage and creates behave normally; Checkout and Portal show a retryable error | [W2], NFR-BILL-2 |
| `it::billing::w3_retry_after_upgrade` | A `402` writes no idempotency row; after `SetPlan` the same key and body give one `202` and one email | [W3], FR-BILL-6 |
| `it::billing::w4_replay_when_spent` | A completed send replays with `deduplicated: true` after the allowance is spent; no hold is taken | [W4] |
| `it::billing::late_subscription_after_erasure` | A workspace is deleted between Checkout and the first webhook: `cancel_billing` finds no customer; the late `checkout.session.completed` and `customer.subscription.created` cancel the new subscription once (`cancelled_after_erasure`, alert fired); a failing cancel answers `500` and the retried event cancels it | [Webhook endpoint](#webhook-endpoint) |
| `it::billing::w5_uncertain_release` | Simulator `timeout@`: the hold is released; a later reconciliation consumes one unit per recipient | [W5], FR-BILL-5 |
| `it::billing::w6_hold_expiry` | An unsettled hold is released by the alarm after 10 minutes of test time; a count hold marks the feature stale and the next hold recounts from D1 | [W6] |
| `it::billing::partial_smtp_settle` | An SMTP send to three recipients with `4xx` on one `RCPT`: two units consumed, one kept held with `expires_at` = retry + 10 min; the retry consumes it; after 24 h of deferral it is released and that delivery is `failed` | FR-BILL-4, FR-BILL-5, [N20](../edge-cases.md) |
| `it::billing::hold_extend_backoff` | A send in quota backoff keeps its hold past 10 minutes; nobody else can take its units | FR-BILL-4, [G3](../edge-cases.md) |
| `it::billing::w7_inbound_never_refused` | Inbound is stored with storage and triage spent; triage ends `skipped` with reason `allowance` | [W7], FR-BILL-8 |
| `it::billing::storage_gate` | Over storage: identity create, domain add and sends with attachments get `402` with `feature: storage_gb`; sends without attachments and inbound work | FR-BILL-8 |
| `it::members::w8_seat_limit` | An invitation with no seat left gets `402` with `feature: seats` | [W8] |
| `it::billing::w11_downgrade_keeps_data` | After a downgrade below current counts, nothing is deleted, existing identities send and receive, new creates get `402` until counts fit | [W11], FR-BILL-9 |
| `it::billing::w12_webhook_order` | Recorded fixtures delivered twice, late and out of order end in the same state; a stale read is recorded `ignored_stale` | [W12] |
| `it::billing::w13_grace_then_free` | `invoice.payment_failed` → `past_due`, `billing.payment_failed`, plan kept; after 7 days of test time Free limits, `billing.plan_changed` (`payment_failed_grace_ended`), nothing deleted; `invoice.paid` restores the plan (`payment_recovered`) | [W13] |
| `it::billing::w14_webhook_signature` | Wrong secret, altered body, `t` older than 300 s, `v0` only, and a replayed request each get `400`; a header with two `v1` values verifies against either secret | [W14] |
| `it::billing::w19_disabled` | `PM_BILLING=off`: no plan checks, `billing: disabled` with every feature `granted: null`, `unlimited: true` and the real `used`, `GET /v1/plans` empty, Stripe routes `404`, the daily caps in tenant policy still return `429` | [W19], FR-BILL-12 |
| `it::billing::period_reset` | Monthly features reset at the period end alarm; a Stripe renewal does not reset twice; starting and ending a subscription start a new period | FR-BILL-3 |
| `it::billing::topups` | Top-up quantities add `1`, `1,000` and `1,000` units; a top-up on Free after a downgrade still counts | FR-BILL-2, PRD §13 |
| `it::billing::reconcile_counts` | Drift between `TenantQuota` and D1 is corrected hourly, but not for a feature with an open hold | FR-BILL-4 |
| `it::billing::stripe_fixtures` | `stripe trigger` fixtures recorded as JSON: checkout completed, subscription updated, payment failed, canceled | M22 |
| `it::billing::plan_managed_by_stripe` | `PATCH …/billing` with `plan_id` on a Stripe-paid workspace gets `409`; on others it sets a complimentary plan and emits reason `operator` | FR-BILL-1 |
| `it::billing::usage_matches_quota` (property) | `GET /v1/usage` equals the catalog plus `TenantQuota` state for random sequences of holds, settles and plan changes | FR-BILL-11, M22 |
| `it::notify::usage_once_per_threshold_per_period`, `it::notify::count_feature_cooldown`, `it::notify::billing_off_no_usage_alerts` | The `TenantQuota` side of usage alerts ([Usage thresholds](#usage-thresholds)), listed in [Notifications § 10](notifications.md#10-tests) | FR-BILL-13, [O20](../edge-cases.md), [O21](../edge-cases.md), [O23](../edge-cases.md) |

[W1]: ../edge-cases.md
[W2]: ../edge-cases.md
[W3]: ../edge-cases.md
[W4]: ../edge-cases.md
[W5]: ../edge-cases.md
[W6]: ../edge-cases.md
[W7]: ../edge-cases.md
[W8]: ../edge-cases.md
[W11]: ../edge-cases.md
[W12]: ../edge-cases.md
[W13]: ../edge-cases.md
[W14]: ../edge-cases.md
[W19]: ../edge-cases.md

Verified (2026-10-09): Stripe documentation at docs.stripe.com, read through WebFetch on this date.
`/api/checkout/sessions/create` (modes `payment`, `setup` and `subscription`; `client_reference_id` up to
200 characters; `customer_update` only with `customer`; `automatic_tax`; `tax_id_collection`; `expires_at`
defaults to 24 hours); `/customer-management` (portal features, ephemeral sessions of 5 minutes unused and
1 hour after activity, and the limitation that a subscription with multiple products can be cancelled but
not updated); `/customer-management/configure-portal` and `/customer-management/portal-deep-links`
(`flow_data` types `payment_method_update`, `subscription_cancel`, `subscription_update`,
`subscription_update_confirm`, `customer_update`); `/billing/subscriptions/webhooks` (the event names used
above and subscription statuses including `unpaid`, `incomplete_expired` and `paused`); `/webhooks`
(manual signature verification: `t` and `v1` in `Stripe-Signature`, HMAC-SHA256 over `{t}.{body}`, ignore
non-`v1` schemes, constant-time comparison, a 5-minute default tolerance in Stripe's libraries, one
signature per active secret during a roll of up to 24 hours, retries for up to three days in live mode,
no ordering guarantee); `/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end`
(periods moved to subscription items, and the request header `Stripe-Version: 2025-03-31.basil`, the one
version string this design pins); `/api/subscriptions/list` (non-canceled subscriptions by default,
`limit` up to 100); `/tax/checkout/page` (Stripe Tax collects only where an active registration exists,
and `customer_update[address]=auto` for existing customers). Not checked: the exact names of restricted-key
permissions in the Stripe Dashboard. Read on 2026-10-10 for the return-page and workspace-deletion calls:
`/api/checkout/sessions/retrieve` (`GET /v1/checkout/sessions/{id}`) and `/api/subscriptions/cancel`
(`DELETE /v1/subscriptions/{id}` cancels at once; `prorate` and `invoice_now` both default to `false`, so
sending neither gives no proration credit and no final invoice).
