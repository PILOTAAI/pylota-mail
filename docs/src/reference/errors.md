# Errors

Every non-2xx response has this body:

```json
{
  "error": {
    "code": "rate_limited",
    "message": "Too many requests for this API key.",
    "retryable": true,
    "fix": "Wait for the number of seconds in the Retry-After header, then retry with the same Idempotency-Key.",
    "request_id": "req_01J9Z4…",
    "details": { "retry_after": 12 }
  }
}
```

| Field | Meaning |
|---|---|
| `code` | Stable, machine-readable, `snake_case`. New codes can be added, so handle unknown codes by HTTP status |
| `message` | Human-readable. It can change. Never parse it |
| `retryable` | `true` means the same request can succeed later unchanged. Retry with backoff, and with the **same** `Idempotency-Key` for sends. `false` means the request has to change |
| `fix` | One sentence telling a developer, or an agent, what to do |
| `request_id` | Quote it in bug reports. It is also in the `Request-Id` header |
| `details` | Optional, code-specific |

A `404` always carries one of this service's own codes. A `404` without this envelope came from
something else (a proxy, a wrong host) and must **not** be read as "already deleted".

## How a client should retry

```text
if status == 2xx                         → done
if error.retryable == false              → do not retry; fix the request
if error.code == "rate_limited"          → sleep Retry-After, retry
if status >= 500 or network error        → retry with exponential backoff + jitter
                                           (0.5 s, 1 s, 2 s, 4 s … cap 60 s, give up after ~10 min)
for sends: ALWAYS reuse the same Idempotency-Key on every retry of the same message
```

A network error on a send is always safe to retry with the same key. You get the original result back,
whether or not the first attempt reached the server.

## Catalogue

### Authentication and access

| HTTP | Code | Retryable | When |
|---|---|---|---|
| 401 | `unauthenticated` | no | No key, a malformed key, or an unknown key |
| 401 | `key_expired` | no | The key passed `expires_at` |
| 401 | `key_revoked` | no | The key was revoked |
| 403 | `permission_denied` | no | The key lacks the permission (`details.required` names it), or the action is turned off for API keys on this deployment: `release` with `PM_QUARANTINE_KEY_RELEASE=off`, where only a signed-in person can release |
| 403 | `scope_denied` | no | The route or field needs a higher key level than the caller's (for example tenant search with an identity key, or `transport` on `PATCH /v1/domains/{domain_id}` with a tenant key), or an identity key tried to write to its tenant's domains or webhooks |
| 403 | `key_scope_exceeded` | no | You tried to create a key wider than your own |
| 403 | `tenant_suspended` | no | The tenant is suspended |
| 403 | `test_mode_recipient` | no | A test tenant tried to send outside the simulator or this deployment |
| 403 | `policy_denied` | no | The tenant's policy forbids the action. In v1.0: a signed HTTP request (`POST …/http-signatures`) while tenant policy `web_bot_auth.allowed` is `false`, the default ([O13](../project/edge-cases.md)). A platform operator turns it on in the tenant's policy |
| 403 | `invalid_signature` | no | An SNS message to `POST /hooks/ses` (SES delivery events) or `POST /hooks/ses/inbound` (SES inbound mail) failed verification: `SignatureVersion` not `2`, a bad signature, a signing certificate not on `sns.{PM_SES_REGION}.amazonaws.com`, another topic, or a stale `Timestamp`. Not returned to API callers |

### Validation

| HTTP | Code | Retryable | When |
|---|---|---|---|
| 400 | `invalid_request` | no | Malformed JSON or schema violation. `details.errors[]` has `{path, message}`. On `POST /v1/keys`, `details.reason = "permission_not_allowed_for_level"` when `permissions` lists one the new key's level cannot hold ([API › Permissions](api.md#permissions)) |
| 400 | `idempotency_key_required` | no | A send without `Idempotency-Key` |
| 400 | `invalid_idempotency_key` | no | Longer than 255 characters, or not printable ASCII |
| 400 | `invalid_query` | no | The search query could not be parsed. `details.position` and `details.expected` say where and what |
| 400 | `address_invalid` | no | Not a valid RFC 5321 address |
| 400 | `address_unsupported` | no | An SMTPUTF8 (non-ASCII) local part ([A3](../project/edge-cases.md)). A non-ASCII name that looks like a reserved name, is mixed-script or contains right-to-left characters gets `address_reserved` instead |
| 400 | `address_reserved` | no | A reserved or confusable local part ([A4](../project/edge-cases.md)). On the shared platform domain this includes every RFC 2142 role name (`info`, `marketing`, `sales`, `support`, `abuse`, `postmaster` and the rest) where it would stand alone as the local part: usernames of the default tenant, whose suffix is empty (`support.acme@…` is not a role address). On a tenant's own domain only `postmaster` and `abuse` are reserved, because mail to them goes to the tenant's owner contact. Names such as `noreply`, `mailer-daemon` and `journal` are reserved everywhere |
| 400 | `local_part_too_long` | no | The username and suffix leave no room for a thread token (more than 40 characters) |
| 400 | `header_not_allowed` | no | A custom header outside the allowed set |
| 400 | `marketing_requirements_missing` | no | `kind: marketing` without `unsubscribe` or `consent` |
| 400 | `too_many_recipients` | no | More than `policy.max_recipients` (hard maximum 49: Cloudflare allows 50 and one is kept for the hidden journal copy) |
| 400 | `smtp_port_not_allowed` | no | `smtp.port` is not `465` or `587` (port `25` included: Workers cannot open outbound connections on it) on a domain create with `method: smtp_relay` or a `PATCH /v1/domains/{domain_id}` with `smtp` |
| 400 | `spf_lookup_limit` | no | Adding a domain whose merged SPF record would need more than 10 DNS lookups (or more than 2 void lookups). `details.lookups` has the count; `fix` names the includes to flatten ([H2](../project/edge-cases.md)) |
| 413 | `message_too_large` | no | The composed message exceeds the transport limit (5 MiB with Cloudflare) |
| 413 | `payload_too_large` | no | The request body exceeds 7 MiB |
| 422 | `scope_too_large` | no | A tenant search over more than 100 identities without an `identity_ids` filter |

### Resources and state

| HTTP | Code | Retryable | When |
|---|---|---|---|
| 404 | `tenant_not_found`, `identity_not_found`, `address_not_found`, `domain_not_found`, `thread_not_found`, `message_not_found`, `attachment_not_found`, `webhook_not_found`, `key_not_found`, `erasure_not_found`, `export_not_found`, `suppression_not_found`, `list_entry_not_found`, `member_not_found`, `invitation_not_found`, `job_not_found`, `dlq_item_not_found` | no | The resource does not exist **or** is outside your scope (deliberately indistinguishable). A signed link that is bad, expired or signed by a retired key also returns its target's code (`attachment_not_found` or `export_not_found`). `key_not_found` also covers an identity signing key's unknown `kid`, and the Web Bot Auth key directory (`/.well-known/http-message-signatures-directory`) while `PM_WEB_BOT_AUTH=off`. `identity_not_found` also covers a `deleting` or `deleted` identity, and the JWK Set (`/.well-known/jwks/{identity_id}.json`) of a paused or suspended identity |
| 409 | `idempotency_conflict` | no | Same key, different request. `details.original_message_id` is included when known |
| 409 | `request_in_progress` | yes | Same key, and the first request is still running |
| 409 | `client_id_conflict` | no | Same `client_id`, different identity body |
| 409 | `username_taken` | no | The username is in use in this tenant |
| 409 | `slug_taken` | no | Another tenant uses this slug |
| 409 | `suffix_taken` | no | Another tenant uses this address suffix, or a second tenant asked for the empty suffix |
| 409 | `not_quarantined` | no | `release` on a message that is not quarantined |
| 409 | `domain_not_suspended` | no | `reprove` on a domain that is not suspended |
| 409 | `existing_mx` | no | Adding a `cloudflare_zone` apex, or a `dns_records` domain, that already has MX records (none of them the expected ones), without `"replace_mx": true` ([H5](../project/edge-cases.md)) |
| 409 | `domain_not_dedicated` | no | A `nameservers` domain whose name has A, AAAA or MX records, or whose `www` has a CNAME, A or AAAA record, without `"confirm_dedicated": true`. Moving the nameservers would stop that website or mail. `details.records` lists what was found |
| 409 | `zone_hold` | no | Cloudflare refused to create the zone because of a zone hold (`nameservers`, `delegated_subdomain`). The fix asks the customer to release the hold (for subdomains) |
| 409 | `owner_required` | no | Tried to remove or demote the workspace owner; transfer ownership first |
| 409 | `plan_managed_by_stripe` | no | Tried to set a plan on a workspace whose plan is paid through Stripe |
| 409 | `address_taken` | no | The address belongs to another identity, or is tombstoned |
| 409 | `address_is_primary` | no | Tried to retire or delete the primary address |
| 409 | `address_in_use` | no | Tried to delete an address that received mail (retire it instead), or to retire or delete the identity's platform address, which stays active as the fallback address for the identity's whole life |
| 409 | `domain_not_ready` | yes | A send from a domain that is `pending` or `verifying`, or from a `pending` address. A `failing` or `suspended` domain is not an error: the send is accepted and falls back to the platform address. Also an identity create whose primary address is on a domain that is not `healthy` or `degraded`, and a `promote` to such an address |
| 409 | `domain_in_use` | no | Tried to remove a domain that still has active or retiring addresses. Also returned with `details.reason = "routing_rule_limit"` when a zone subdomain already has 200 literal routing rules and another address is added |
| 409 | `domain_exists` | no | The domain is already registered in this deployment |
| 409 | `identity_paused` | no | The identity is paused. `details.reason` says why (`tenant_suspended` for every identity of a suspended tenant). A paused identity also cannot sign agent assertions or HTTP requests ([O1](../project/edge-cases.md)) |
| 409 | `identity_owner_required` | no | The identity has no accountable human |
| 409 | `thread_busy` | yes | Another send holds the thread lock. Retry after `details.retry_after` |
| 409 | `not_cancelable` | no | The message is past `queued` |
| 409 | `not_uncertain` | no | `resolve` was called on a message that is not `uncertain` |
| 409 | `auto_reply_not_allowed` | no | An auto-reply to automated mail, or over the automatic-exchange limit ([D6](../project/edge-cases.md)) |
| 410 | `raw_expired` | no | Raw MIME is past retention |
| 410 | `cursor_expired` | no | A pagination cursor older than 24 hours |
| 423 | `legal_hold` | no | `DELETE …/messages/{message_id}` on a message whose thread is under a legal hold. Nothing was created. Erasure requests (`POST /v1/erasure-requests`) never return it: they skip held threads and list them in the receipt |

### Policy and limits

| HTTP | Code | Retryable | When |
|---|---|---|---|
| 422 | `all_recipients_suppressed` | no | Never returned at send time: a fully suppressed send is accepted and ends `suppressed`. Returned only by a dry-run (`?dry_run=true`) |
| 422 | `recipient_blocked` | no | A dry-run found a recipient on the send-block list |
| 422 | `transport_unavailable` | no | The deployment or the domain's method cannot do what was asked. `details.reason` is one of `ses_not_configured` (the SES transport, `PM_SES_*`, is not configured: `dns_records`, `send_only`, `PATCH` to `ses`), `ses_receiving_not_configured` (`dns_records`, or `smtp_relay` with `inbound: ses`, without `PM_SES_INBOUND_TOPIC_ARN`, bucket and queue), `ses_identity_limit` (the SES region already has 10,000 identities), `subdomain_setup_disabled` (`delegated_subdomain` while `PM_CF_SUBDOMAIN_SETUP` is not `on`), `zone_creation_not_allowed` (`nameservers` by a tenant key whose policy lacks `domains.allow_create_zone: true`) or `method_not_supported` (the domain's method does not support the operation: `PATCH` with a transport it cannot use, `probe` without the `smtp` transport, `test-forwarding` without `inbound: forward`) |
| 422 | `smtp_tls_required` | no | The SMTP relay does not offer STARTTLS on port 587 (or TLS on 465). The credentials were not sent. Returned by domain create (`smtp_relay`) and by `PATCH /v1/domains/{domain_id}` with `smtp`; also a domain health issue |
| 422 | `smtp_auth_failed` | no | The SMTP relay answered `535` to AUTH. Returned by domain create (`smtp_relay`) and by `PATCH /v1/domains/{domain_id}` with `smtp`; also a domain health issue |
| 422 | `cf_token_required` | no | `PM_CF_API_TOKEN` is not set, and a domain create with `method` `cloudflare_zone`, `nameservers` or `delegated_subdomain`, or an identity or address that needs a literal routing rule, needs it. For an apex `cloudflare_zone`, `pmail domains add --local-token` with your own Cloudflare token works instead (catch-all, no literal rules) |
| 422 | `agentic_disabled` | no | Agentic search is turned off by tenant policy |
| 422 | `address_limit_reached` | no | The identity already has 20 addresses in any state |
| 422 | `webhook_limit_reached` | no | The tenant (or platform) already has 20 webhook endpoints |
| 422 | `web_bot_auth_disabled` | no | Signed HTTP requests are turned off on this deployment (`PM_WEB_BOT_AUTH=off`, the default): `POST …/http-signatures`, and rotating the `web_bot_auth` key with `POST /v1/platform/keys/web_bot_auth/rotate` ([O9](../project/edge-cases.md)) |
| 402 | `billing_limit` | no | A plan allowance is spent (`details`: `feature`, `granted`, `used`, `resets_at`, `upgrade_url`). Nothing was stored: upgrade or add a top-up, then retry with the **same** `Idempotency-Key` |
| 429 | `rate_limited` | yes | A per-key or per-identity rate limit (including signing: 600 assertions and HTTP signatures a minute per identity), or the per-domain limit of `verify` and `probe` (one a minute). Has `Retry-After` |
| 429 | `daily_cap_reached` | yes | A tenant or identity daily cap. `details.resets_at` says when it resets |
| 429 | `agentic_budget_exhausted` | yes | The tenant's daily agentic-search budget is spent |
| 429 | `upstream_rate_limited` | yes | A provider's rate limit stopped the request before anything changed. Cloudflare refused to create a zone with error 1105 (too many attempts to add a domain), for `nameservers` or `delegated_subdomain`: `Retry-After` and `details.retry_after` are `10800` (3 hours). Or the deployment's Amazon SES control-plane budget (one call per second, shared by every domain) had no slot within 5 seconds, for a domain create, `PATCH` or removal that calls SES: `Retry-After` is the wait, usually a few seconds |

A `402 billing_limit` is never returned for inbound mail (FR-BILL-8) or for replays of requests that already
completed (FR-BILL-6). On a deployment with billing `disabled`, only the daily caps in tenant policy apply,
and they return `429 daily_cap_reached` or `429 agentic_budget_exhausted`.

### Server and dependencies

| HTTP | Code | Retryable | When |
|---|---|---|---|
| 500 | `internal_error` | yes | A bug. Logged with `request_id` |
| 502 | `upstream_error` | yes | A Cloudflare or SES API returned an unexpected error during a synchronous call (domain add, verify), or the SMTP relay could not be reached when a domain create (`smtp_relay`) or a `PATCH` with `smtp` tested it |
| 503 | `unavailable` | yes | A dependency is temporarily unavailable (D1, a Durable Object overloaded) |
| 503 | `search_degraded` | yes | Only when the request set `"require_mode": true` and the requested mode is unavailable. Otherwise search degrades and sets `degraded: true` |
| 504 | `timeout` | yes | An internal deadline was exceeded. For sends this happens **before** the message is queued, so a retry with the same key is safe |

## Send failures after `202`

Errors after a send was accepted do not come back as HTTP errors. They arrive as message status and
events (`message.rejected`, `message.failed`, `message.uncertain`, `message.bounced`). The reason codes
in `data.reason` are:

| Reason | Status | Meaning |
|---|---|---|
| `provider_validation` | `rejected` | The transport refused the content (header, size, format) |
| `sender_domain_unavailable` | `rejected` | The domain is not onboarded with the transport |
| `recipient_suppressed_by_provider` | per recipient `suppressed` | The provider's own suppression list. Synced into ours |
| `quota_exhausted` | `failed` | The provider's rate limit or daily limit, still refusing after 24 hours of back-off (rate-limit back-offs are capped at 24 hours too), or an SMTP relay still unavailable after 24 hours of retries |
| `transport_timeout` | `uncertain` | No answer from the transport. It may have been sent |
| `transport_connection_lost` | `uncertain` | The connection dropped after the request was written |
| `resolved_not_sent` | `failed` | A human resolved an uncertain send as not sent |
| `domain_failing_no_fallback` | `failed` | The domain failed and fallback was disabled by policy |

### How provider errors map to reasons

The transport's answer decides the reason. An answer that is not clearly definitive is treated as
unknown, because an `uncertain` send that a person or a later event settles is safer than a retry that
could send twice. `uncertain` sends are **never resent automatically**.

| Provider answer | Status | Reason | Retried |
|---|---|---|---|
| Cloudflare validation and header codes (`E_VALIDATION_ERROR`, `E_FIELD_MISSING`, `E_TOO_MANY_RECIPIENTS`, `E_CONTENT_TOO_LARGE`, `E_HEADER_*`, `E_HEADERS_*`, `E_TOO_MANY_ATTACHMENTS`, `E_RECIPIENT_NOT_ALLOWED`); SES `MessageRejected`, `BadRequestException` and other 4xx | `rejected` | `provider_validation` | never |
| Cloudflare `E_DELIVERY_FAILED` (the recipient server refused the message) | `rejected` | `provider_validation` | never |
| A per-recipient provider event `failed` or `rejected` (Cloudflare event subscription, SES `Reject` or `Rendering Failure`) | that recipient `failed` or `rejected`; the message rolls up | `provider_validation` | never |
| Cloudflare `E_SENDER_DOMAIN_NOT_AVAILABLE`, `E_SENDER_NOT_VERIFIED`; SES `MailFromDomainNotVerifiedException`, `NotFoundException` | `rejected` | `sender_domain_unavailable` | never |
| Cloudflare `E_RECIPIENT_SUPPRESSED` | the recipient `suppressed` (or `rejected` when it cannot be identified) | `recipient_suppressed_by_provider` | the other recipients, once |
| Cloudflare `E_RATE_LIMIT_EXCEEDED`, `E_DAILY_LIMIT_EXCEEDED`; SES `TooManyRequestsException`, `LimitExceededException`, `SendingPausedException`, `AccountSuspendedException` | stays `queued` with back-off, then `failed` after 24 hours | `quota_exhausted` (at the end) | yes, it was definitely not sent |
| SMTP relay (`smtp_relay` domains): `535` or another `5xx` to `AUTH`, or no `STARTTLS` on port 587 (credentials never sent) | `rejected`; the domain gets issue `smtp_auth_failed` or `smtp_tls_required` | `sender_domain_unavailable` | never |
| SMTP relay: `5xx` to `MAIL FROM` or to the final `.`, or to every `RCPT TO` | `rejected` | `provider_validation` | never |
| SMTP relay: `5xx` to one `RCPT TO` | that recipient `rejected`; the others continue | `provider_validation` | never for that recipient |
| SMTP relay: any failure before the final `.` is written (connect, TLS, `4xx` to `AUTH`, `MAIL FROM` or every `RCPT TO`, a dropped connection), or `4xx` to the final `.`. A `4xx` to some `RCPT TO` keeps only those recipients `queued` | stays `queued` with back-off, then `failed` after 24 hours | `quota_exhausted` (at the end) | yes, it was definitely not sent |
| Cloudflare `E_INTERNAL_SERVER_ERROR`, any Cloudflare code not listed here, an error without a code; SES 5xx; a dropped connection; an SMTP connection lost after the final `.` and before its reply | `uncertain` | `transport_connection_lost` | **never** |
| No answer within 30 seconds; SMTP: no reply to the final `.` within 60 seconds | `uncertain` | `transport_timeout` | **never** |

The full table, with the exact Cloudflare and SES codes, is in
[Outbound design › Transport outcome classification](../project/design/outbound.md#transport-outcome-classification).
