# Plans and billing

There are two ways to run Pylota Mail. You can host it yourself on your own Cloudflare account, free and
with no plan limits. Or you can use Pylota Mail Cloud, Pylota's hosted deployment of the same code, on the
Free, Developer or Team plan. This guide covers both: what each plan includes, what counts against it,
what happens at a limit, how to change plans, and how an agent reads its own limits.

## Self-hosting

Self-hosting is free under FSL-1.1-ALv2. You pay only your own Cloudflare usage
([Deploy to Cloudflare](../self-hosting.md)).

- Billing is **off** by default (`PM_BILLING=off`). You need no Stripe account, and `pmail setup` never
  asks for one.
- There are **no plan limits**. Nothing returns `402 billing_limit`.
- You can still set **quotas** in each tenant's policy: daily send caps per identity and per tenant
  (`identity_daily_send_cap`, `tenant_daily_send_cap`) and the daily agentic-search cap
  (`search.agentic_daily_cap`). They return `429 daily_cap_reached` or `429 agentic_budget_exhausted`
  ([Configuration › Tenant policy](../reference/configuration.md#tenant-policy)).
- `GET /v1/usage` still reports what each workspace uses, with `"billing": "disabled"`, no plan limits,
  and any operator quota from tenant policy.

Turning billing on (`PM_BILLING=stripe`, with a plan catalog and Stripe keys) is an operator choice,
described in the [billing design](../project/design/billing.md#self-host-mode). FSL-1.1-ALv2 does not
permit offering the software to others as a competing commercial product or service, so read
[PRD §12](../project/prd.md#12-licensing) before you charge anyone for a deployment.

## Pylota Mail Cloud

Pylota Mail Cloud is the same Worker, run by Pylota, with billing on. Each workspace has a plan, and the
plan's allowances are enforced exactly.

**Pylota Mail Cloud opens with the v1.0 release.** Until then there is nothing to sign up for, and this
page describes how the plans will work. Releases are announced in the
[GitHub repository](https://github.com/PILOTAAI/pylota-mail).

### Plans

| | Free | Developer | Team | Self-host |
|---|---|---|---|---|
| Price (GBP, excl. VAT) | £0 | £10 a month | £49.50 a month | £0 under FSL-1.1-ALv2 |
| Inboxes (identities) | 5 | 10 | 100 | no plan limits |
| Sends per month | 1,000 | 10,000 | 100,000 | |
| Triage analyses per month | 500 | 10,000 | 100,000 | |
| Custom domains | none | 5 | 50 | |
| Storage | 1 GB | 10 GB | 100 GB | |
| Seats | 1 | 2 | 10 | |
| Top-ups | none | £1 per unit | £1 per unit | |
| Support | GitHub issues | email | priority email | contracts available |

Every plan includes the full API, the MCP server, the CLI, the console, quarantine review and all four
search modes. The per-identity send limits ([Sending › Caps](sending.md#caps-and-automatic-pausing)) stay
on every plan as an abuse backstop.

**New workspaces on Free** can send 50 messages a day for their first 7 days (`429 daily_cap_reached`
above that). The ramp lifts on day 7 if bounce and complaint rates stay under the automatic-pause
thresholds, or at once when the workspace moves to a paid plan.

Agentic search is not a plan allowance. It is rate-limited per key (20 a minute) and capped per workspace
per day (`search.agentic_daily_cap`, 500 by default).

### What counts

| Allowance | What one unit is | Kind |
|---|---|---|
| Inboxes | One identity, `active` or `paused`. Its addresses are free | Count |
| Sends | One recipient. A message to three recipients uses three sends | Monthly |
| Triage analyses | One stored analysis of an inbound message | Monthly |
| Custom domains | One domain of your own, whatever its [connection method](custom-domains.md#choose-how-to-connect-your-domain). The shared platform domain is free | Count |
| Storage | Stored mail and attachments, in GB, rounded up and measured hourly | Measured |
| Seats | One member of the workspace, or one pending invitation | Count |

Only work that happened counts:

- A send is counted when the transport accepts it. A rejected, failed or cancelled send costs nothing, and
  neither does a recipient skipped because of a suppression.
- An **uncertain** send ([Sending › Uncertain sends](sending.md#uncertain-sends)) releases what it held.
  It is counted later only if reconciliation shows it went out, or if a person resolves it as `sent`.
- A triage analysis is counted only when it is stored. A failed analysis is refunded. Quarantined mail is
  triaged, and counted, only when someone releases it.
- Inbound mail itself is never counted against a plan.

Each allowance is reserved before the action runs, in one place per workspace. Two requests can never
both take the last unit: one succeeds and the other gets `402 billing_limit`.

## Top-ups

A **top-up unit** is one inbox, 1,000 sends or 1,000 triage analyses. It costs £1 and is added to your
plan each month while it is subscribed. Top-ups are available on Developer and Team. Custom domains, storage and
seats have no top-up: they come with the plan.

For example, Developer with two send top-ups has 12,000 sends a month. A top-up counts from the moment
Stripe confirms it, in the current month.

## When allowances reset

| Allowance | Resets |
|---|---|
| Sends, triage analyses | At the start of each billing period |
| Inboxes, custom domains, seats, storage | Never: they are counts of what exists now |

On a paid plan, the billing period is your Stripe subscription's: it starts on the day you subscribed and
renews monthly. On Free, periods are calendar months, starting at 00:00 UTC on the 1st. Starting or ending
a subscription starts a new period, so monthly counts begin again at zero.

`GET /v1/usage` gives each allowance's exact `resets_at`.

## What happens at a limit

When an allowance is spent, the action that needs it is refused **before anything is stored**:

```json
{
  "error": {
    "code": "billing_limit",
    "message": "This workspace has used its sends for this billing period.",
    "retryable": false,
    "fix": "Upgrade the plan or add a top-up, then retry with the same Idempotency-Key.",
    "request_id": "req_01JA2Q7M…",
    "details": { "feature": "sends", "granted": 12000, "used": 12000,
                 "resets_at": "2026-11-01T00:00:00Z",
                 "upgrade_url": "https://mail.example.com/console/plan" }
  }
}
```

- **Safe to retry after an upgrade.** The `402` is returned before any idempotency record is written. When
  the workspace upgrades or adds a top-up, the same request with the **same** `Idempotency-Key` succeeds,
  and the email is sent once ([Sending › Safe retries](sending.md#safe-retries)).
- **Not retryable as it is.** `retryable` is `false`: retrying without a change gets the same answer. An
  agent should stop, tell a person, and keep the key and the body for later.
- **Replays still work.** Retrying a send that already succeeded returns its original result, with
  `deduplicated: true`, even when the allowance is now spent.
- **All or nothing.** A send to three recipients with two sends left is refused whole. Nothing is sent.
- **The first refusal** of each allowance in a billing period emits a `billing.limit_reached` event.

**Inbound mail is never refused** because of a plan. When the triage allowance is spent, mail is still
stored and delivered to your webhooks; triage is skipped with reason `allowance` (the deterministic risk
flags are still set), and you can re-run it after a top-up ([Triage](triage.md#re-run-triage)).

**Storage over its allowance** blocks only new identities, new domains and outbound messages with
attachments, each with `402 billing_limit` and `feature: "storage_gb"`. Mail keeps arriving, and sends
without attachments keep working. Delete or erase mail, shorten retention, or upgrade to bring it back
under the limit.

## Upgrade, downgrade and cancel

Plans are managed on the console's **Plan and usage** page (`/console/plan`). Every member can see it.
Only the workspace **owner** can change the plan, and the console asks the owner to confirm with a code if
they last signed in more than 10 minutes ago.

- **Upgrade from Free.** Choose Developer or Team. The console sends you to a Stripe Checkout page to pay.
  The plan applies as soon as Stripe confirms the payment, usually within seconds, and a new billing period
  starts.
- **Add top-ups.** On Developer or Team, choose how many units of inboxes, sends or triage analyses to add.
  The first purchase of each kind goes through Checkout.
- **Change plan, change top-ups, update the card, see invoices, cancel.** **Manage billing** opens the
  Stripe Customer Portal. A change applies when Stripe confirms it; Stripe prorates the price.
- **Cancel.** The plan stays until the end of the period you paid for, then the workspace moves to Free.

**A downgrade never deletes data.** If you have more identities, custom domains or members than the new
plan allows, all of them are kept and keep working: identities still send and receive, domains still
send, members can still sign in. Creating more is refused with `402 billing_limit` until the counts fit
the new plan. If you have already used more sends or triage analyses this period than the new plan
allows, those are refused until the next reset.

Pending invitations count as seats. To free seats, revoke invitations or remove members on the
**Members** page.

## Failed payments

If a renewal payment fails, the workspace keeps its plan for a **7-day grace period**
(`PM_BILLING_GRACE_DAYS`):

1. A `billing.payment_failed` event is sent, with `grace_until`, and the console shows a banner.
2. Stripe retries the payment. The owner can also pay or change the card in the Customer Portal.
3. If the payment succeeds within the grace period, nothing else happens.
4. If not, the workspace moves to **Free limits** and a `billing.plan_changed` event is sent with reason
   `payment_failed_grace_ended`. Nothing is deleted: counts above Free's limits behave as after a
   downgrade.

Paying later restores the plan, with a `billing.plan_changed` event whose reason is `payment_recovered`.

## Reading usage

Agents can read their own limits before they hit one ([REST API › Usage](../reference/api.md#usage-and-audit)).

**`GET /v1/usage`** works with any key for its own workspace (other workspaces need `usage:read`;
platform keys pass `tenant_id`):

```bash
curl https://mail.example.com/v1/usage -H "Authorization: Bearer $PYLOTA_MAIL_KEY"
```

```json
{
  "billing": "metered",
  "plan": { "plan_id": "developer", "status": "active", "current_period_end": "2026-11-01T00:00:00Z",
            "cancel_at_period_end": false },
  "features": [
    { "feature": "inboxes",        "granted": 10,    "used": 4,    "remaining": 6,    "unlimited": false, "resets_at": null },
    { "feature": "sends",          "granted": 12000, "used": 8312, "remaining": 3688, "unlimited": false, "resets_at": "2026-11-01T00:00:00Z" },
    { "feature": "triage",         "granted": 10000, "used": 2210, "remaining": 7790, "unlimited": false, "resets_at": "2026-11-01T00:00:00Z" },
    { "feature": "custom_domains", "granted": 5,     "used": 1,    "remaining": 4,    "unlimited": false, "resets_at": null },
    { "feature": "storage_gb",     "granted": 10,    "used": 2,    "remaining": 8,    "unlimited": false, "resets_at": null },
    { "feature": "seats",          "granted": 2,     "used": 2,    "remaining": 0,    "unlimited": false, "resets_at": null }
  ],
  "topups": { "inboxes": 0, "sends": 2, "triage": 0 },
  "plans": [ { "plan_id": "free", "name": "Free", "price": 0, "currency": "gbp", "interval": "month",
               "included": { "inboxes": 5, "sends": 1000, "triage": 500, "custom_domains": 0, "storage_gb": 1, "seats": 1 },
               "topups": false, "support": "github_issues" } ]
}
```

- `billing` is `metered`, `exempt` (no limits) or `disabled` (self-hosted without billing).
- `granted` includes top-ups. `remaining` also allows for actions in flight, so it is what you can use now.
- `plans` is the full plan catalog.

**`GET /v1/usage/daily`** (`usage:read`) gives per-day figures: inbound, outbound, sends, triage, search,
agentic searches, AI usage and storage, for up to 92 days per request.

**`GET /v1/plans`** needs no key. It returns the plan catalog, or `{ "billing_enabled": false, "data": [] }`
on a deployment without billing.

**CLI.** `pmail usage` prints the allowances table, and `pmail usage daily` the per-day figures. Add
`--json` for the raw response.

**MCP.** [`mail_get_usage`](../reference/mcp.md#mail_get_usage) returns the same object. It is read-only
and takes no input; every tenant and identity key sees it for its own workspace. A `billing_limit` tool
error also carries the feature, the numbers and `resets_at` in its `details`.

## Tax

Prices are in pounds sterling (GBP) and exclude VAT. Every customer is billed in GBP; there are no
local-currency prices in v1.0. Stripe Tax adds UK VAT, and VAT or sales tax in other countries, where it
is due, based on the billing address you enter on the Checkout page. A business can add its VAT or other tax
ID there or in the Customer Portal, and it appears on invoices.

## Support

| Plan | Support |
|---|---|
| Free | GitHub issues |
| Developer | Email |
| Team | Priority email |
| Self-host | Support contracts are available |

Security problems go to the process in [SECURITY.md](https://github.com/PILOTAAI/pylota-mail/blob/main/SECURITY.md),
never to a public issue.

## Related

- [Limits › Plans](../reference/limits.md#plans) and [Limits › Console](../reference/limits.md#console)
- [Errors › Policy and limits](../reference/errors.md#policy-and-limits)
- [Webhook events › Workspaces, members and billing](../reference/events.md#workspaces-members-and-billing)
- [Billing design](../project/design/billing.md) and [Console design](../project/design/console.md)
- [PRD §13, business model and pricing](../project/prd.md#13-business-model-and-pricing)
