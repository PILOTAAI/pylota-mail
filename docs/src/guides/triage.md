# Triage

Triage reads every inbound message once, when it arrives, and records what kind of mail it is,
whether it needs a reply, how urgent it is, a one-line summary and any risks. Agents read the triage
first and decide what to open; people use it to sort a queue. This guide explains what triage
produces, the categories and risk flags, deterministic rules, and how to use and re-run it.

## What triage produces

Every inbound message that is not quarantined is triaged in the background after it is stored
([FR-TRI-1](../project/prd.md#69-triage)). The result is the message's `triage` object:

```json
"triage": {
  "status": "done",
  "category": "billing",
  "needs_reply": 0.15,
  "urgency": 1,
  "summary": "Brightwell invoice 88213 for AB12 CDE brake work, £412.80 inc VAT.",
  "language": "en",
  "risk_flags": [],
  "model": "@cf/openai/gpt-oss-20b",
  "version": 3,
  "reason": null
}
```

| Field | Meaning |
|---|---|
| `status` | `pending` (not run yet), `done`, `skipped` (not run: triage is off for the tenant, the message is not eligible, or the workspace's `triage` allowance is spent) or `failed` (see below) |
| `category` | One of the built-in categories, or one of the tenant's own |
| `needs_reply` | 0 to 1: how likely it is that the message expects an answer from this identity |
| `urgency` | 0 to 3 |
| `summary` | At most 280 characters |
| `language` | A BCP 47 tag, for example `en` or `de` |
| `risk_flags` | Zero or more of the flags below |
| `model`, `version` | What produced the result. `model` is `"rules"` when rules alone decided |
| `reason` | `null` unless `status` is `skipped` (`policy_disabled`, `not_eligible`, `allowance`) or `failed` (`invalid_output`, `model_unavailable`, `input_unavailable`) |

When triage finishes, or fails, a `message.triaged` event carries the `triage` object. Each thread
also shows the `category`, `needs_reply` and `urgency` of its latest triaged inbound message, so you
can sort threads without opening them.

If the model's output still does not validate against the triage schema after one retry, the status
is `failed`; the service never guesses ([FR-TRI-4](../project/prd.md#69-triage)). If Workers AI is
unavailable, triage stays `pending` and is retried with back-off; after the last attempt it is `failed`
with reason `model_unavailable`.

## Categories

| Category | Typical mail |
|---|---|
| `customer_request` | A customer asks for something: a booking change, a question, a complaint |
| `vendor` | Suppliers and partners: garages, body shops, parts, cleaning |
| `billing` | Invoices, receipts, payment confirmations, statements |
| `legal_compliance` | Fines, penalty charge notices, insurance claims and decisions, legal letters, regulators |
| `verification` | Sign-up codes, verification and password-reset links |
| `notification` | Automated notices from systems: account alerts, shipping updates |
| `newsletter` | Newsletters the identity subscribed to |
| `marketing` | Promotional mail |
| `auto_reply` | Out-of-office and other automatic replies |
| `personal` | Personal mail unrelated to the business |
| `spam` | Unwanted mail that was not quarantined |
| `other` | Anything else |

To use your own categories, set `triage.categories` in the tenant policy to a list of up to 20
`{ "name", "description" }` objects. It **replaces** the built-in list. The description is what the
model reads, so write it as a short definition:

```json
{
  "policy": {
    "triage": {
      "categories": [
        { "name": "booking",  "description": "Customers asking to book, change or cancel a rental" },
        { "name": "pcn",      "description": "Penalty charge notices from councils and parking operators" },
        { "name": "claim",    "description": "Insurance claims and correspondence with insurers" },
        { "name": "billing",  "description": "Invoices and statements from garages and suppliers" },
        { "name": "other",    "description": "Anything else" }
      ]
    }
  }
}
```

Set it back to `null` to return to the built-in list. A workspace changes its own policy on the console's
policy page (owners and admins) or with `PATCH /v1/tenants/{tenant_id}/policy` and a tenant key that holds
`policy:write`; categories and rules are free fields, so any workspace may set them
([Configuration › Tenant policy](../reference/configuration.md#tenant-policy)).

## Needs-reply and urgency

`needs_reply` is a score from 0 to 1, not a yes or no. Automated mail, newsletters and receipts score
low; a customer's direct question scores high. Pick your own threshold for "show this to an agent":
the thread list's `needs_reply_gte` filter takes one, and the search operator `is:needs_reply` uses the
service's default.

`urgency` is an integer from 0 to 3. Read it roughly as:

| `urgency` | Roughly |
|---|---|
| 0 | No time pressure |
| 1 | Within a few days |
| 2 | Soon: today or tomorrow, or a customer waiting |
| 3 | Urgent: a deadline within hours, or a legal or financial consequence |

Urgency is a hint for ordering work. It is also a target for manipulation (urgent pressure is a
classic phishing tactic), so treat a high urgency together with risk flags as a reason for more care,
not for faster action.

## Risk flags

| Flag | Raised when |
|---|---|
| `payment_change_request` | The message asks to change bank details, pay a new account, or pay urgently ([D8](../project/edge-cases.md)) |
| `credential_request` | It asks for passwords, codes or login details |
| `prompt_injection_suspected` | It contains text aimed at an AI, such as instructions to ignore rules or to send data ([E1](../project/edge-cases.md)) |
| `phishing_suspected` | It looks like a phishing attempt, for example a credential lure or a deceptive link |
| `impersonation_suspected` | It appears to come from someone it does not, for example a spoofed display name or a look-alike domain ([D2](../project/edge-cases.md)) |
| `urgent_pressure` | It pushes for immediate action |
| `unknown_sender` | The identity has never exchanged mail with the sender |
| `auth_failed` | The message failed authentication (it was quarantined and later released) |
| `attachment_risky` | An attachment carries a `risk` |
| `hidden_text` | Hidden text was found and removed ([B11](../project/edge-cases.md)) |

Risk flags come from built-in rules (for example the payment-change and hidden-text detectors), from
the authentication and attachment checks, and from the model. Pylota Mail never acts on them. Your
application decides what they mean: for example, require a person's approval before an agent acts on
any message with `payment_change_request` or `prompt_injection_suspected`.

## Rules

Deterministic rules run **before** the model ([FR-TRI-2](../project/prd.md#69-triage)). Use them for
mail you can recognise reliably: a council's PCN address, a garage's invoices, an insurer's claim
mailbox. A rule can fix the category and the needs-reply score, raise the urgency, add labels, and skip
the model entirely, which is faster, cheaper and predictable.

Rules live in the tenant policy, in `triage.rules` (up to 50 rules):

```json
{
  "policy": {
    "triage": {
      "rules": [
        {
          "id": "council-pcn",
          "match": {
            "from_domain": ["leeds.gov.example", "parking.example"],
            "subject_contains": ["penalty charge", "pcn"]
          },
          "set": { "category": "legal_compliance", "labels_add": ["pcn"], "urgency_min": 3, "needs_reply": 0.9 },
          "stop": true
        },
        {
          "id": "garage-invoices",
          "match": {
            "from": ["accounts@brightwell.example"],
            "has_attachment": true,
            "subject_contains": ["invoice"]
          },
          "set": { "category": "billing", "labels_add": ["invoice"], "urgency_min": 1, "needs_reply": 0.1, "skip_model": true }
        },
        {
          "id": "claims-mailbox",
          "match": {
            "to_identity": ["claims"],
            "body_contains": ["claim number", "claim reference"]
          },
          "set": { "category": "legal_compliance", "labels_add": ["claim"], "urgency_min": 2 }
        }
      ]
    }
  }
}
```

### Rule fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique in the list: `^[a-z0-9][a-z0-9_-]{0,47}$`. The IDs of the rules that matched are stored with the triage record for audit and debugging |
| `match` | yes | The conditions, at least one. **All** listed conditions must hold. Within a list, **any** value may match |
| `set` | yes | What the rule sets, at least one of the fields below |
| `stop` | no | `true` ends tenant rules once this rule matches. Default `false` |

| `set` field | Meaning |
|---|---|
| `category` | A category from the effective list: the built-in list, or your own list if you set one |
| `needs_reply` | 0 to 1. Fixes the value; the model cannot change it |
| `urgency_min` | 0 to 3. The lowest urgency the message can get; the model can raise it but not lower it |
| `labels_add` | Up to 10 labels to add to the message |
| `skip_model` | `true` to finish triage without calling the model |

Each list holds at most 20 entries and each string at most 200 characters.

### Match conditions

| Condition | Matches when |
|---|---|
| `from` | The From address is one of these addresses (case-insensitive) |
| `from_domain` | The From address is at one of these domains or any of their subdomains |
| `to_identity` | The message was delivered to one of these identities of the tenant (identity IDs `idn_…` or usernames) |
| `subject_contains` | The subject contains one of these strings (case-insensitive) |
| `body_contains` | The first 64 KB of `extracted_text` contains one of these strings (case-insensitive) |
| `has_attachment` | The message has (`true`) or has no (`false`) attachment that is not inline |
| `label` | The message carries one of these labels, including labels added by an earlier rule in the same run |

### Evaluation order

1. **Tenant rules** run first, in the order they appear in `triage.rules`. Every rule whose `match`
   holds is applied, but **the first match wins** for `category` and for `needs_reply`: once a rule
   has set one of them, later rules cannot change it. `urgency_min` takes the highest value of all
   matching rules, labels accumulate, and `skip_model` holds if any matching rule sets it. A matching
   rule with `"stop": true` ends tenant rules; no later tenant rule runs.
2. **Built-in category rules** run next, in a fixed order: delivery reports, read receipts,
   auto-replies, verification mail, list mail, automated notices, likely spam. The first one that
   matches sets `category` and `needs_reply` only where no tenant rule did, and skips the model. With
   your own category list, a built-in category rule applies only if its category is in your list.
3. **Built-in risk-flag rules** always run and raise the [risk flags](#risk-flags).
4. If `skip_model` is set, triage finishes here: `category` is the rule's (else `other`),
   `needs_reply` the rule's (else 0), `urgency` is `urgency_min`, the `summary` is built from the
   sender and subject, and `model` is `"rules"`.
5. Otherwise the model runs, receiving the message as fenced, untrusted data. A `category` or
   `needs_reply` set by a rule is kept; `urgency` is the higher of the model's value and
   `urgency_min`. Risk flags from the model are added to those from the built-in rules.

Tenant rules cannot add or remove risk flags. Flags raised by built-in rules are never removed, by a
rule or by the model.

Rules change triage for mail that arrives afterwards. To apply new rules to a message already
triaged, [re-run triage](#re-run-triage) on it.

## Use triage

- **Thread lists:** `GET /v1/identities/{identity_id}/threads?needs_reply_gte=0.7&category=customer_request`
  returns the threads waiting for an answer, newest first. The CLI equivalent is `pmail triage list`.
- **Search:** `category:billing`, `category:legal_compliance is:needs_reply`
  ([Search](search.md#query-operators)).
- **Webhooks:** subscribe to `message.triaged` to route work as soon as triage finishes, instead of on
  `message.received`.
- **Agents:** read `summary`, `category` and `risk_flags` first, and open the full message only when
  the summary says it is relevant. That keeps the context window small.

## Re-run triage

```bash
curl -X POST https://mail.example.com/v1/identities/idn_01J9Z3K8V4/messages/msg_01J9…/triage \
  -H "Authorization: Bearer $PYLOTA_MAIL_KEY"
```

Re-running needs `messages:write` and returns `202`. A new `message.triaged` event follows. The CLI
command is `pmail triage rerun`. Re-run after changing categories or rules, or after a `failed`
result. A message released from quarantine is triaged automatically.

## Triage is advisory

Triage **never sends, deletes or releases a message** ([FR-TRI-3](../project/prd.md#69-triage)). It
does not decide quarantine either: quarantine is decided by authentication, spam score and attachment
checks before triage runs. A wrong category can make an agent look at the wrong thing first, but it
cannot make anything happen. Actions stay with your application, and the people who approve them.

## Privacy

- Triage runs on Workers AI **in your own Cloudflare account**. The model is set by
  `PM_TRIAGE_MODEL` (default `@cf/openai/gpt-oss-20b`).
- If you set `PM_AI_GATEWAY`, model calls (which carry mail content) pass through that AI Gateway.
  Pylota Mail turns off the gateway's log collection and caching on every call that carries mail
  content, so the gateway keeps only request metadata (model, time, tokens) for those calls. Its rate
  limits and other settings still apply.
- Mail content is never written to logs at any log level.
- To turn triage off for a tenant, set `triage.enabled: false`. New messages then get
  `status: "skipped"`.
