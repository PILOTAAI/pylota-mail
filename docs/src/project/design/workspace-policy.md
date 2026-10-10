# Workspace policy

Binding for implementation. This page lets a workspace change its own tenant policy, inside the limits
that the deployment, the platform operator and, for a partner's tenant, the partner have set. The owner
decided on 2026-10-10 that workspace owners can edit their own policy ([ADR 0010](../adr/0010-workspace-policy-self-service.md));
before that, only a platform key or the tenant's partner key could change it, so a Cloud customer needed a
support request to the operator to shorten retention or add a booking-number pattern.

| | |
|---|---|
| Requirements | FR-TEN-4 (this page), FR-KEY-4, FR-CON-2, FR-CON-5, FR-CON-6; and the tenant choices it makes possible: FR-PRV-2, FR-TRI-1, FR-TRI-2, FR-SRCH-4, FR-OUT-10, FR-IN-8 |
| Edge cases | [J14](../edge-cases.md), [J20](../edge-cases.md)–[J24](../edge-cases.md) |
| Code | `crates/core/src/policy.rs` (`check_write`, `effective`, the field table; pure), `crates/worker/src/policy/{mod.rs, write.rs, view.rs}`, `handlers/tenants.rs` (the two `/policy` routes, and the `policy` of `POST /v1/tenants` and `PATCH /v1/tenants/{tenant_id}`), `crates/worker/src/auth/people.rs` (decisions reserved for people), `console/pages/policy.rs` |
| Tables | D1 `tenants` (`policy_json`, `policy_ceilings_json`, `partner_ceilings_json`, `policy_version`), `audit_log`, `event_index` ([Data model](data-model.md#1-d1-control-plane)) |
| Contracts | `GET` and `PATCH /v1/tenants/{tenant_id}/policy` and the `policy:write` permission ([REST API › Tenants](../../reference/api.md#tenants)); the field classes ([Configuration › Who may change a field](../../reference/configuration.md#who-may-change-a-field)); the event `tenant.policy_updated` ([Webhook events](../../reference/events.md#workspaces-members-and-billing)) |
| Built in | [M5](../build-plan.md#m5--worker-base-routing-auth-tenants-keys) (the service, the routes, the checks, audit and event) and [M21](../build-plan.md#m21--console-and-workspaces-after-m7m14-and-m25-whose-services-its-pages-use) (the console page) |

## 1. Who writes the policy

There is one policy-write service, `policy::write`, and four kinds of writer. Every route that writes a
policy calls it: `POST /v1/tenants` (the `policy` of a new tenant), `PATCH /v1/tenants/{tenant_id}` (with
`policy`), `PATCH /v1/tenants/{tenant_id}/policy` and the console's policy page.

| Writer | Through | Rules applied | A value it sets on a lower-only field |
|---|---|---|---|
| Platform key | `PATCH /v1/tenants/{tenant_id}` (`tenants:manage`), or `PATCH …/policy` (`policy:write`) | None: every field, any valid value | Becomes the **platform ceiling** (`tenants.policy_ceilings_json`) |
| The partner key of the tenant's own partner | The same two routes, and `POST /v1/tenants` | The partner column of [Who may change a field](../../reference/configuration.md#who-may-change-a-field) | Becomes the **partner ceiling** (`tenants.partner_ceilings_json`) |
| A tenant key of the tenant holding `policy:write` | `PATCH …/policy` only: a tenant key can never hold `tenants:manage` | The workspace column | No ceiling |
| A console owner or admin of the workspace | `/console/settings/policy` ([§6](#6-the-console-page)) | The workspace column, as a person ([§3](#3-decisions-reserved-for-people)) | No ceiling |

A **workspace writer** is either of the last two. Identity keys can never hold `policy:write`: like
`members:manage`, it is a tenant-only permission ([Security §4.6](security.md#46-creating-keys-fr-key-1)),
so an agent's own key cannot change the rules that apply to it. A platform or partner key that holds
`policy:write` may use `PATCH …/policy` instead of `PATCH /v1/tenants/{tenant_id}`; the rules follow the
key's level, not the route.

**Owners and admins.** Both console roles hold `policy:write`. An admin already holds every other
tenant-level permission ([Console › Roles](console.md#roles)): domains, webhooks, keys, and identity-scope
erasure, which deletes more mail than a shorter retention does. Making policy owner-only would leave a team
whose owner is its billing contact unable to tune triage or search without that person, while the
controls that matter apply to both roles alike: every save needs a sign-in within the last 10 minutes and
writes an audit row, a change that deletes mail asks for an explicit confirmation ([§6](#6-the-console-page)),
and the ceilings and classes bind owners exactly as they bind admins. Members and viewers see the
effective policy read-only.

## 2. Classes and ceilings

Every field of the [tenant policy](../../reference/configuration.md#tenant-policy) belongs to one class.
The field-by-field table is in [Configuration › Who may change a field](../../reference/configuration.md#who-may-change-a-field);
`core::policy::FIELDS` holds the same table as data, and a unit test fails when a field of `TenantPolicy`
has no entry.

| Class | Fields | A workspace writer |
|---|---|---|
| Platform-only | `web_bot_auth.allowed`, `domains.allow_create_zone`, `domains.cloudflare_zones` | `403 scope_denied`, `details.reason = "not_writable"` |
| Platform or own partner | `quarantine.key_release` | `403 scope_denied`, `details.reason = "not_writable"` ([J14](../edge-cases.md)) |
| Lower-only | The 16 fields of the configuration table, and `accounts.require_approval` | At most its **workspace ceiling**; above it `403 scope_denied`, `details.reason = "above_ceiling"`, `details.ceiling`, `details.ceiling_source` ([J20](../edge-cases.md)) |
| Guard | `send_allowlist_only`, `quarantine.on_auth_fail`, `quarantine.spam_threshold`, `quarantine.unsolicited_otp` | Any value as a person; a key may only tighten, unless keys may take decisions reserved for people ([§3](#3-decisions-reserved-for-people), [J22](../edge-cases.md)) |
| Free | Every other field | Any valid value |

**Workspace ceiling.** For a lower-only field, the loosest value a workspace writer may set is the strictest
of:

1. the **deployment default**: the built-in default merged with `PM_DEFAULT_POLICY`;
2. the **platform ceiling**: the value a platform key last set on the field, from
   `tenants.policy_ceilings_json`, when there is one;
3. the **partner ceiling**: for a tenant with a `partner_id`, the value its partner's key last set on the
   field (at creation or later), from `tenants.partner_ceilings_json`, when there is one.

`details.ceiling_source` names the one that decided (`deployment`, `platform` or `partner`; on a tie, the
first in that order). A partner key is bounded by the first two only, as before; its own partner ceiling
never binds it ([J23](../edge-cases.md)).

**Which value is looser.** For numbers, the higher one, as in the partner rules (a higher abuse threshold
pauses later; longer retention keeps more). For the switches `auto_reply.allowed`,
`inbound.extract_image_text`, `triage.enabled` and `search.agentic_enabled`, `true` is looser (it sends mail
or spends Workers AI). For `accounts.require_approval`, `false` is looser: it lets agents receive
verification codes from services nobody approved ([Service sign-up ledger](service-accounts.md)), which
spends the reputation of the shared addresses with third-party services. So on Pylota Mail Cloud, whose
`PM_DEFAULT_POLICY` sets it to `true` ([Cloud commissioning](../cloud-commissioning.md#5-the-cloud-default-policy)),
no workspace and no partner can turn it off; only a platform key can.

**`null`.** From a workspace writer, `null` on a lower-only field resets it to the deployment default and is
checked as that value, so it is refused when a platform or partner ceiling is stricter. On a guard field it
is checked as a write of the default value ([§3](#3-decisions-reserved-for-people)). On a free field it is
always accepted. A platform key's `null` removes the platform ceiling, and the tenant's partner key's
`null` removes the partner ceiling, as each also resets the value.

**When ceilings are checked.** At write time only. A later change to `PM_DEFAULT_POLICY`, or a later
platform or partner value, does not rewrite what a workspace stored; the platform or partner key that wants
the tenant lower sets the field, which sets the value and the ceiling together.

## 3. Decisions reserved for people

FR-CON-6 makes releasing quarantined mail a person's decision on Pylota Mail Cloud, because an agent's
key can be steered by the mail it reads. Two more decisions have the same effect, letting mail or codes
that nobody reviewed reach agents, so they follow the same rule, implemented once in
`auth::people::key_may_decide(scope, tenant_policy) -> bool`:

| Decision | Where |
|---|---|
| Release a quarantined message | `POST …/messages/{message_id}/release` ([Security §5.3](security.md#53-cross-level-read-access)) |
| Loosen a guard field of the policy | `PATCH …/policy`, from a tenant key (this section) |
| Approve a service account | `POST …/accounts/{account_id}/approve` ([Service sign-up ledger §4](service-accounts.md#4-approval)) |

An API key may take these decisions only when `PM_QUARANTINE_KEY_RELEASE` is `on`, or `PM_CONSOLE` is `off`
(no person could take them), or the tenant's policy has `quarantine.key_release: true` (a platform key or the
tenant's partner key opted the tenant in, as Pylota does for its operators' review screen). Otherwise the
key gets `403 permission_denied` with `details.reason = "person_required"`, and a signed-in person decides
in the console. A console session is a person, so `key_may_decide` is never asked for it.

**Guard fields.** A write by a tenant key **tightens** a guard field when the new value is at least as
strict as the tenant's current effective value: `true` for `send_allowlist_only`,
`quarantine.on_auth_fail` and `quarantine.unsolicited_otp`, and a value at or below the current
`quarantine.spam_threshold` (a lower threshold quarantines more). A tightening is always accepted. Any other
value loosens: accepted when `key_may_decide` is true, otherwise `403 permission_denied` with
`details.reason = "person_required"` and `details.field` ([J22](../edge-cases.md)). Guard fields have no
ceilings: a person in the console may set any value, and platform and partner keys write them freely, as
before. A partner that wants a guard field fixed for its tenants gives neither `policy:write` nor the owner
or admin role to anyone who should not change it.

## 4. The write

`policy::write(writer, tenant_id, patch) -> Result<PolicyView, ApiError>`. The route has already
authenticated the key, checked the permission, resolved the tenant within the key's scope and refused a
write to an `erasing` or `erased` tenant from a non-platform key (`404 tenant_not_found`,
[I8](../edge-cases.md)). Then:

1. **Validate** the patch against `TenantPolicyPatch` (types, bounds, enums, array sizes, the `regex`
   compile limit of `search.custom_refs`): `400 invalid_request` with `details.errors[]`. An empty patch is
   `400 invalid_request`.
2. **Read** `policy_json`, `policy_ceilings_json`, `partner_ceilings_json`, `policy_version`,
   `partner_id` and `status` of the tenant in one D1 query, and compute the effective policy:
   built-in defaults ⊕ `PM_DEFAULT_POLICY` ⊕ `policy_json` (`core::policy::effective`).
3. **Check** with `core::policy::check_write(writer, &patch, &effective, &deployment_defaults,
   &platform_ceilings, &partner_ceilings, key_may_decide)`, a pure function. It walks the dotted paths
   present in the patch in sorted order, and the first refused path decides the error, so the reported
   `details.field` is deterministic. One refused field refuses the whole write: nothing is stored.
4. **Build** the new `policy_json` (deep merge; `null` removes the key so the default applies; arrays
   replace) and, for a platform writer, set or remove each lower-only path present in
   `policy_ceilings_json`; for the tenant's partner key, the same in `partner_ceilings_json`. A workspace
   writer changes neither ceiling. A write that changes no stored value still counts as a write (it is
   audited and evented, so a repeated save is visible).
5. **Commit** one D1 batch, every statement guarded by the version read in step 2, as the partner deletion
   guards its batch ([Data model › Notes](data-model.md#notes)):

   ```sql
   INSERT INTO audit_log (id, tenant_id, actor_key_id, actor_user_id, action, target_type, target_id,
                          details_json, request_id, created_at)
   SELECT ?aud, ?1, ?key, ?user, 'tenant.policy_update', 'tenant', ?1, ?details, ?req, ?now
   WHERE EXISTS (SELECT 1 FROM tenants WHERE id = ?1 AND policy_version = ?v);
   INSERT INTO event_index (id, tenant_id, identity_id, type, owner_kind, owner_id, partner_id,
                            payload_json, occurred_at)
   SELECT ?evt, ?1, NULL, 'tenant.policy_updated', 'platform', 'platform', partner_id, ?payload, ?now
   FROM tenants WHERE id = ?1 AND policy_version = ?v;
   UPDATE tenants SET policy_json = ?p, policy_ceilings_json = ?pc, partner_ceilings_json = ?ptc,
                      policy_version = policy_version + 1, updated_at = ?now
   WHERE id = ?1 AND policy_version = ?v;
   ```

   A D1 batch runs as one transaction, so the three statements see the same row. When the `UPDATE`
   changed no row (`meta.changes = 0`), another write won: re-read and repeat from step 2, at most three
   attempts in all, then `503 unavailable` (retryable) ([J24](../edge-cases.md)).
6. **After commit**, queue the event's `Fanout` ([Webhooks › Platform events](webhooks.md#platform-events);
   the every-minute outbox sweep is the safety net) and return the view of [§5](#5-the-api).

**When a change takes effect.** Every reader re-reads `policy_json`: the inbound consumer for each message
([Inbound › Steps](inbound.md#steps), step 1), the send path for each submit, search and triage for each
request or job. A new cap or rule applies to the next message processed. A shorter `retention.*` applies at
the tenant's next daily retention job ([Privacy §5](privacy.md#5-retention)); nothing is deleted at write
time.

## 5. The API

The contract is in [REST API › Tenants](../../reference/api.md#tenants) and `openapi.yaml`
(`getTenantPolicy`, `updateTenantPolicy`):

| Route | Permission | Key levels | Returns |
|---|---|---|---|
| `GET /v1/tenants/{tenant_id}/policy` | `policy:write` | platform, partner (its own tenants), tenant (its own) | `TenantPolicyView` |
| `PATCH /v1/tenants/{tenant_id}/policy` | `policy:write` | the same | `TenantPolicyView` after the write |

`TenantPolicyView` is `{ tenant_id, policy_version, policy, fields }`: `policy` is the full effective
policy, and `fields` lists every field with what the **caller** may do with it: `class`, `writable` (may it
set any value at all), `ceiling` (for lower-only fields, the loosest value it may set, or `null` when no
ceiling binds it), `ceiling_source`, and `person_required_to_loosen` (guard fields, for a key that may not
take decisions reserved for people). Clients and the console build their forms from it, so they never offer
a value that the write would refuse. `GET` is a read: it writes no audit row.

Errors: `400 invalid_request`; `403 permission_denied` (no `policy:write`, or `person_required` with
`details.field`); `403 scope_denied` (`details.field`, `details.reason` = `not_writable` or
`above_ceiling`, with `details.ceiling` and `details.ceiling_source` for the second); `403 partner_suspended`;
`404 tenant_not_found` (out of scope, or a non-platform write to an `erasing` or `erased` tenant);
`503 unavailable` after three lost compare-and-set attempts. `PATCH /v1/tenants/{tenant_id}` returns the
same refusals for the `policy` it carries, with the same `details`.

## 6. The console page

`/console/settings/policy` ([Console › Screens](console.md#screens)), rendered from the same
`policy::view` as `GET …/policy`, for the session principal:

- **Every role** sees the effective policy, grouped as Sending (caps, recipients, allow-list only, large
  attachments and link lifetime, AI disclosure, domain fallback), Automatic replies, Quarantine, Inbound,
  Retention, Triage, Search, Webhooks, Abuse thresholds and Service accounts. A field the session cannot
  change is shown as text with the reason: "set by the platform operator", "set by your provider" (a
  partner ceiling; the partner's name is never shown to a tenant) or "the deployment's limit".
- **Owners and admins** get one `<form method="post">` with the CSRF token ([Console › CSRF](console.md#csrf))
  and a hidden `policy_version`. Numbers are `<input type="number">` with `max` set to the ceiling,
  switches are checkboxes, enums are radio buttons, `search.refs_packs` and
  `inbound.extract_attachment_text` are checkbox groups, and `triage.categories`, `triage.rules` and
  `search.custom_refs` are `<textarea>`s holding JSON. There is no JavaScript: the `max` attribute is a
  hint, and the server checks everything.
- **Saving** is a sensitive action: it needs a sign-in within the last 10 minutes
  ([Console › Re-authentication](console.md#re-authentication)). The handler compares each submitted value
  with the effective policy read at submit time and sends only the fields that differ, as one patch, to
  `policy::write` with `Writer::Workspace { person: true }`; an unchanged field is never part of the write,
  so it is never checked. When the stored `policy_version` differs from the hidden one, nothing is stored and
  the page is shown again with the current values and the notice "The policy changed since you opened this
  page". A refused field is shown next to its input with the error's `fix`.
- **Deleting changes.** When the patch lowers `retention.raw_days` or `retention.events_days`, or sets
  `retention.message_days` to a number (from `null`) or lowers it, the first `POST` changes nothing and
  shows a confirmation page that names what the next daily retention run will delete ("Messages older than
  30 days will be deleted, except threads under a legal hold"), with a required checkbox `confirm_deletion`.
  Only the second `POST`, with the checkbox, writes.
- The audit row has `actor_user_id` and `details_json.via = "console"`, like every console action
  ([Console › Audit and events](console.md#audit-and-events)).

## 7. Audit and events

| Record | When | Contents |
|---|---|---|
| Audit `tenant.policy_update` | Every policy write except the `policy` of `POST /v1/tenants` (its `tenant.create` row covers it) | `target_type = "tenant"`; `details_json` = `{ "fields": [dotted paths written], "changes": [{ "field", "from", "to" }], "level": "platform" \| "partner" \| "tenant" \| "console", "via": "api" \| "console" }`. `changes` lists only number and boolean fields; text, arrays and objects (triage rules, custom patterns, disclosure text) are named in `fields` only, because they can hold addresses, which audit rows never contain |
| Event `tenant.policy_updated` | The same writes | A platform event ([Webhooks › Platform events](webhooks.md#platform-events)) with `tenant_id` set, `identity_id` `null` and `sequence` `null`. `data`: `fields`, `by` (`platform`, `partner`, `tenant` or `console`), `actor_key_id`, `actor_user_id`, `policy_version`. It reaches the tenant's endpoints, its partner's endpoints and platform endpoints that have no identity filter, so a partner learns when a workspace member changed its policy |

## 8. A partner's tenants

On Pylota Mail Cloud, Pylota's partner key creates each operator's workspace and sets its policy, for
example `quarantine.key_release: true` and a lower `tenant_daily_send_cap`. Every lower-only value it sets
becomes that tenant's partner ceiling, so:

- a tenant key that Pylota minted with `policy:write`, or a person Pylota invited as owner or admin, may
  lower that field again or change free fields, never raise it above Pylota's value;
- guard fields follow [§3](#3-decisions-reserved-for-people): because Pylota's tenants have
  `quarantine.key_release: true`, Pylota's own tenant keys may loosen them; a person may too;
- `quarantine.key_release` and the platform-only fields stay out of reach of the tenant;
- Pylota receives `tenant.policy_updated` on its partner endpoints whenever a policy changes.

## 9. Tests

| Test | Proves | Covers |
|---|---|---|
| `core::policy::workspace_write_table` (table test over `FIELDS`) | For each field and each writer (platform, partner, workspace key, workspace person), `check_write` gives the class's outcome: platform-only and `quarantine.key_release` refused to workspace writers with `not_writable`; a lower-only field accepted at its ceiling and refused one step above it with `above_ceiling` and the right `ceiling_source` (deployment, platform, partner, and the order on ties); `accounts.require_approval` treated with `false` as looser; `null` checked as the default; the first refused path in sorted order reported; every field of `TenantPolicy` has a `FIELDS` entry | FR-TEN-4, §2 |
| `it::policy::j20_workspace_ceilings` | Through `PATCH …/policy` with a tenant key holding `policy:write`: lowering `tenant_daily_send_cap`, `retention.raw_days` and an `abuse` threshold, and turning off `triage.enabled`, are accepted; raising one above the deployment default, or turning on a switch the default has off, gets `403 scope_denied` with `details.field`, `reason = "above_ceiling"`, `ceiling` and `ceiling_source = "deployment"`, and nothing is stored even when other fields of the write are valid; after a platform key sets 200, the tenant key may set 200 and not 201 (`ceiling_source = "platform"`); a free field (`search.custom_refs`, `retention.message_days`) is accepted; `GET …/policy` reports the same ceilings | [J20](../edge-cases.md) |
| `it::policy::j21_workspace_field_classes` | A tenant key with `policy:write` writing `web_bot_auth.allowed`, `domains.allow_create_zone`, `domains.cloudflare_zones` or `quarantine.key_release` gets `403 scope_denied` with `details.field` and `reason = "not_writable"`; a tenant key without `policy:write` gets `403 permission_denied` on both `/policy` routes; minting an identity key with `policy:write` gets `400 invalid_request` (`permission_not_allowed_for_level`); a partner key of another partner gets `404 tenant_not_found` | [J21](../edge-cases.md), [J14](../edge-cases.md) |
| `it::policy::j22_guard_fields_need_person` | With `PM_QUARANTINE_KEY_RELEASE=off` and no `quarantine.key_release`, a tenant key setting `quarantine.on_auth_fail` or `quarantine.unsolicited_otp` to `false`, raising `quarantine.spam_threshold`, or setting `send_allowlist_only` to `false` gets `403 permission_denied` with `reason = "person_required"` and `details.field`; lowering `spam_threshold` and setting the switches to `true` are accepted; with `quarantine.key_release: true`, or with `PM_QUARANTINE_KEY_RELEASE=on`, the same key loosens them; a console owner loosens them after re-authentication | [J22](../edge-cases.md) |
| `it::policy::j23_partner_ceiling` | A partner key sets `tenant_daily_send_cap` 1,000 on its tenant (at creation, and again by `PATCH`): a tenant key of that tenant may set 800, then 1,000, and gets `403 scope_denied` with `ceiling_source = "partner"` at 1,001; the partner key itself may set 2,000 (bounded only by the deployment default and the platform ceiling); a partner `null` removes the partner ceiling and resets the value; a tenant without a partner is never bound by `partner_ceilings_json` | [J23](../edge-cases.md) |
| `it::policy::j24_concurrent_writes` | Two writes racing on one tenant (a partner key and a tenant key, and two console saves): both commit in some order with no lost field, `policy_version` rises by two, each has one audit row and one event row; a fault-injected stream of version changes makes the request fail after three attempts with `503 unavailable` and stores nothing; a console save with a stale `policy_version` stores nothing and shows the notice | [J24](../edge-cases.md) |
| `it::policy::policy_updated_event_and_audit` | Every policy write (platform and partner `PATCH /v1/tenants/{tenant_id}`, `PATCH …/policy` by each level, a console save) writes one `tenant.policy_update` row with `fields`, number and boolean `changes` only, `level` and `via`, and one `tenant.policy_updated` `event_index` row in the same batch; `POST /v1/tenants` writes neither; from M8 the event is delivered to the tenant's, its partner's and platform endpoints and never to another partner's | §7 |
| `it::console::policy_page` | Every role sees the page; only owner and admin get the form; a save needs re-authentication, sends only changed fields, writes an audit row with `actor_user_id`; a field above its ceiling is refused with its `fix` shown; a retention decrease first shows the confirmation page and writes nothing until `confirm_deletion` is posted; the page works with JavaScript off | §6, FR-CON-5 |
