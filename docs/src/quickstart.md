# Quickstart

In this quickstart you will:

1. get an API key and log in with the `pmail` CLI;
2. create an identity for a bookings agent;
3. send an email with an idempotency key (with `curl`, the Rust SDK and the CLI) and see a retry
   return the original result;
4. read a reply and answer it;
5. search the mailbox and ask it a question;
6. add a webhook and connect an MCP client.

It takes about ten minutes. To try everything without sending real mail, use a test tenant (see
[Try it without sending real mail](#try-it-without-sending-real-mail)).

## Before you start

You need:

- a running Pylota Mail deployment. This page uses `https://mail.example.com` as its API host and
  `agents.example` as its platform mail domain. To run your own, follow
  [Deploy to Cloudflare](self-hosting.md) first;
- the `pmail` CLI, from the GitHub Releases page or with `cargo install pylota-mail-cli --locked`;
- `curl`, for the REST examples.

Conventions on this page:

- The tenant is `acme` (Acme Car Hire). Its address suffix is `.acme`, so its identities' platform
  addresses look like `bookings.acme@agents.example`.
- IDs are shortened for readability. Real IDs are a prefix plus a 26-character ULID, for example
  `msg_01J9Z3K8V4QW7X2M5N6P8R0T1Y`.
- From [step 4](#4-send-an-email) on, examples use `bookings@acme.example.com`. That is the address
  the identity has once Acme's own domain is added and promoted
  ([Custom domains](guides/custom-domains.md)). If you are only on the platform domain, use
  `bookings.acme@agents.example` instead. Every `--identity` option accepts any active or retiring
  address of the identity, or its `idn_` ID.

## 1. Get a key

Every request carries an API key: `Authorization: Bearer pmk_live_…` (or `pmk_test_…` for test
tenants). Keys have a level (platform, partner, tenant or identity) and a list of permissions. See
[API keys and permissions](concepts.md#api-keys-and-permissions).

**If someone else runs the deployment**, ask them for a tenant key for your tenant. This quickstart
needs these permissions: `identities:read`, `identities:write`, `messages:read`, `messages:send`,
`messages:write`, `attachments:read`, `search:read`, `search:agentic`, `webhooks:manage` and
`keys:manage`.

**If you deployed it yourself**, you have a platform key from
[`pmail keys create --level platform`](self-hosting.md#5-create-the-first-api-key), saved in your CLI's
`default` profile. Use it to create the tenant and a tenant key, so day-to-day work does not use the
platform key:

```bash
pmail tenants create --slug acme --name "Acme Car Hire"

pmail keys create --level tenant --tenant acme --name acme-quickstart \
  --permissions identities:read,identities:write,messages:read,messages:send,messages:write,attachments:read,search:read,search:agentic,webhooks:manage,keys:manage
```

If you keep the platform key somewhere else, set `PYLOTA_MAIL_URL` and `PYLOTA_MAIL_KEY` for these two
commands, then unset `PYLOTA_MAIL_KEY`: a key in the environment outranks every profile.

The key's secret (`pmk_live_…`) is printed **once**. It is stored only as a keyed hash, so it
cannot be shown again. If you lose it, create a new key and revoke the old one.

## 2. Log in

```bash
pmail login --profile acme
pmail config set default_profile acme
```

`pmail login` asks for the API URL (`https://mail.example.com`) and the tenant key, checks the key, and
saves both as the profile `acme` in `~/.config/pylota-mail/config.toml`; `config set default_profile`
makes `pmail` read that profile when you name none. Name the profile: without `--profile`, `login` writes
the profile `default`, which holds your platform key if you deployed Pylota Mail yourself. The file is
created with mode `0600`, and `pmail` refuses to read it if its group or other users have any access to
it.

You can also skip the file and set `PYLOTA_MAIL_URL` and `PYLOTA_MAIL_KEY` in your environment. Flags
come first, then the environment, then the profile, so a `PYLOTA_MAIL_KEY` in the environment is the key
`pmail` uses. See [CLI › Configuration](reference/cli.md#configuration).

Check the key with the API. The `curl` examples on this page read the tenant key from
`PYLOTA_MAIL_KEY`; with it exported, the CLI uses the same key:

```bash
export PYLOTA_MAIL_KEY=pmk_live_…            # the tenant key
curl -s https://mail.example.com/v1/me -H "Authorization: Bearer $PYLOTA_MAIL_KEY"
```

```json
{
  "key_id": "key_01J9…", "name": "acme-quickstart", "level": "tenant", "mode": "live",
  "tenant_id": "ten_01J9…", "identity_id": null,
  "permissions": ["identities:read", "identities:write", "messages:read", "..."],
  "expires_at": null
}
```

## 3. Create an identity

Create the bookings agent's identity:

```bash
pmail identities create --username bookings --display-name "Acme Car Hire"
```

```json
{
  "id": "idn_01J9Z3K8V4", "tenant_id": "ten_01J9…",
  "username": "bookings", "display_name": "Acme Car Hire",
  "status": "active", "primary_address": "bookings.acme@agents.example",
  "owner": null,
  "...": "…"
}
```

An identity cannot send until it records an **accountable human**: the person responsible for what
the agent sends ([FR-IDN-2](project/prd.md#62-identities-and-addresses)). Without one, sends fail with
`409 identity_owner_required`. Set the owner:

```bash
pmail identities update bookings.acme@agents.example \
  --owner-name "Sam Patel" --owner-email sam@acmecarhire.example
```

You can also pass `--owner-name` and `--owner-email` to `pmail identities create` directly.

Create a second identity for the compliance agent, which you will use in [step 7](#7-ask-a-question):

```bash
pmail identities create --username compliance --display-name "Acme Car Hire Compliance" \
  --owner-name "Sam Patel" --owner-email sam@acmecarhire.example
```

Usernames match `^[a-z0-9][a-z0-9._-]{0,23}$`, and the username plus the tenant suffix can be at most
40 characters. Reserved names such as `postmaster`, `abuse` and `noreply`, and look-alikes of them, are
refused with `address_reserved` ([A4](project/edge-cases.md)).

If your application provisions identities automatically, pass a `client_id` (for example
`acme:bookings`) in the API request. Repeating the same create then returns the existing identity
instead of making a second one ([Identities](reference/api.md#identities)).

## 4. Send an email

Every send needs an `Idempotency-Key`: a string you choose that names *this* message, such as
`bk-2291-confirm` for the confirmation of booking BK-2291. If you retry with the same key and the
same body, you get the original result back, never a second email.

### With curl

```bash
curl -X POST https://mail.example.com/v1/identities/idn_01J9Z3K8V4/messages \
  -H "Authorization: Bearer $PYLOTA_MAIL_KEY" \
  -H "Idempotency-Key: bk-2291-confirm" \
  -H "Content-Type: application/json" \
  -d '{"to":["renter@example.org"],"subject":"Your booking BK-2291","text":"Your car is ready at 9:00."}'
```

The response is `202 Accepted` with the new message:

```json
{
  "id": "msg_01JA5C2H8R", "thread_id": "thr_01JA5C2H8Q", "identity_id": "idn_01J9Z3K8V4",
  "direction": "outbound", "status": "queued", "kind": "transactional",
  "from": { "address": "bookings@acme.example.com", "name": "Acme Car Hire" },
  "to": [ { "address": "renter@example.org", "name": "" } ],
  "subject": "Your booking BK-2291",
  "deduplicated": false,
  "...": "…"
}
```

Run exactly the same command again. You get the same `id` with `"deduplicated": true`, and the
response carries the header `Idempotent-Replayed: true`. One email was sent.

If you reuse the key with a *different* body, the request fails with `409 idempotency_conflict`. That
protects you from a bug where two different messages share a key. Use a new key for a new message.

### With the Rust SDK

Add the SDK, pinned to the same version as your deployment (`GET /health` returns it):

```toml
[dependencies]
pylota-mail = "=X.Y.Z"   # replace with your deployment's version
```

```rust
use pylota_mail::Client;

async fn confirm_booking(key: String) -> Result<(), pylota_mail::Error> {
    let client = pylota_mail::Client::new("https://mail.example.com", key);
    let sent = client
        .identity("idn_01J9Z3K8V4")
        .send()
        .to("renter@example.org")
        .subject("Your booking BK-2291")
        .text("Your car is ready at 9:00.")
        .idempotency_key("bk-2291-confirm")
        .await?;
    // a retry with the same key returns this same message
    println!("{} deduplicated={}", sent.id, sent.deduplicated);
    Ok(())
}
```

### With the CLI

```bash
pmail send --identity bookings@acme.example.com \
  --to renter@example.org --subject "Your booking BK-2291" \
  --text "Your car is ready at 9:00." \
  --idempotency-key bk-2291-confirm
```

```json
{ "id": "msg_01JA5C2H8R", "status": "queued", "deduplicated": true }
```

`deduplicated` is `true` here because you already sent this message with `curl`.

### Follow the message

`queued` means accepted. The message then moves to `submitted` (the transport took it) and
`delivered`, or to another [outbound status](reference/api.md#outbound-status). Check it with:

```bash
pmail messages get msg_01JA5C2H8R --identity bookings@acme.example.com
```

The per-recipient outcome is in `deliveries`. Webhooks report the same changes as `message.sent`,
`message.delivered`, `message.bounced` and so on (see [step 8](#8-add-a-webhook)).

## 5. Read a reply and answer it

When the renter replies, the reply joins the same thread. Pylota Mail matches it by the thread
token in the `Reply-To` address it set on your message, or by the `In-Reply-To` and `References`
headers. The subject alone never joins a thread.

List the threads that need attention:

```bash
pmail threads list --identity bookings@acme.example.com
```

```json
{
  "data": [{
    "id": "thr_01JA5C2H8Q", "subject": "Your booking BK-2291",
    "participants": [ { "address": "renter@example.org", "name": "Jo Rivera" } ],
    "message_count": 2, "unread_count": 1, "last_direction": "inbound",
    "snippet": "Could we move the pick-up to Friday…",
    "category": "customer_request", "needs_reply": 0.92, "urgency": 2
  }],
  "next_cursor": null
}
```

Read the thread:

```bash
pmail threads get thr_01JA5C2H8Q --identity bookings@acme.example.com
```

Each message carries:

- `extracted_text`: the new content, with quoted history and signatures removed. Read this first;
  it is what fits in a model's context;
- `trust`: the authentication verdict (`pass`, `fail`, `softfail`, `none`, `unaligned` or `unverified`),
  `known_sender`, `spam_score` and flags such as `display_name_spoof`;
- `triage`: category, needs-reply score, urgency, summary and risk flags.

Everything in a message (subject, names, body, filenames) is **untrusted content**. Show it to a
model as data, never as instructions. See [Security](guides/security.md).

Reply. A reply needs its own idempotency key:

```bash
pmail reply msg_01JA6D3J9S --identity bookings@acme.example.com \
  --text "Friday works. See you at 10." \
  --idempotency-key bk-2291-reply-1
```

The same with `curl`:

```bash
curl -X POST https://mail.example.com/v1/identities/idn_01J9Z3K8V4/messages/msg_01JA6D3J9S/reply \
  -H "Authorization: Bearer $PYLOTA_MAIL_KEY" \
  -H "Idempotency-Key: bk-2291-reply-1" \
  -H "Content-Type: application/json" \
  -d '{"text":"Friday works. See you at 10."}'
```

The reply goes to the sender, from the address they wrote to, with `Re:` added to the subject once
and `In-Reply-To` and `References` set. See
[Who a reply goes to](guides/sending.md#who-a-reply-goes-to).

## 6. Search

Search one identity's mailbox:

```bash
pmail search "from:@brightwell.example ref:AB12CDE has:attachment" --identity bookings@acme.example.com
```

This finds mail from any address at that domain that mentions the plate AB12 CDE (with or without
the space) and has an attachment. Each hit has a `snippet`, a `why` list explaining the match (for
example `ref:AB12CDE (attachment p.1)`) and the sender's `trust`.

Vehicle plates and PCNs come from the optional `uk_vehicle` reference pack. The tenant policy is
changed with a platform key that holds `tenants:manage`, so ask your deployment's operator, or run
this yourself if you deployed it:

```bash
curl -X PATCH https://mail.example.com/v1/tenants/ten_01J9… \
  -H "Authorization: Bearer $PLATFORM_KEY" -H "Content-Type: application/json" \
  -d '{"policy":{"search":{"refs_packs":["core","uk_vehicle"]}}}'
```

References are extracted when mail arrives, so turn the pack on before the mail you want to find
comes in.

The default mode is `hybrid` (keyword and semantic together). Use `--mode keyword` for exact
lookups and `--mode semantic` for meaning. The operators and modes are in [Search](guides/search.md).

## 7. Ask a question

Agentic search plans the searches for you and answers with citations:

```bash
pmail ask "Did the insurer accept the Golf claim?" --identity compliance@acme.example.com
```

The CLI streams progress (each search step and the evidence found), then prints the answer with
numbered citations, the cited messages, and the status:

```text
⋯ step 1  search "claim Golf photos" (hybrid) · 7 hits · 412 ms
⋯ step 2  read thread thr_01JA… · 38 ms

Yes. Admiral accepted claim 7781 on 2 October, after the photos sent on 28 September [1][2].

[1] msg_01JA…  2026-10-02  Admiral Claims <claims@admiral.example>  "Claim 7781 – decision"
[2] msg_01JB…  2026-09-28  Acme Car Hire <compliance@acme.example.com>  "Photos for claim 7781"

answered · confidence 0.86 · 3 steps · 2.8 s
```

Every sentence cites message IDs (the API returns them as `[msg_…]` markers; the CLI numbers them), and
code checks each citation against the evidence before the answer is returned. If the mail does not answer the question, the status is `insufficient_evidence`,
never a guess. Agentic search needs the `search:agentic` permission. See
[Search › Agentic search](guides/search.md#agentic-search).

## 8. Add a webhook

Webhooks tell your application what happened. Create an endpoint:

```bash
pmail webhooks create --url https://api.example.com/webhooks/mail \
  --events message.received,message.bounced
```

The response includes the signing secret, `whsec_…`. **It is shown only once.** Store it with your
application's other secrets. Then send a test event:

```bash
pmail webhooks test whk_01JA…
```

Your endpoint receives a `webhook.test` event. Verify the signature on every request and
deduplicate on the `webhook-id` header: the
[receiving guide](guides/receiving.md#set-up-a-webhook-endpoint) has the steps and a Rust example.
The event types are in [Webhook events](reference/events.md).

## 9. Connect an MCP client

Give the agent its own identity key with only what it needs:

```bash
pmail keys create --level identity --identity bookings@acme.example.com --name bookings-agent \
  --permissions messages:read,messages:send,search:read,attachments:read
```

Add the server to your MCP client's configuration. `pmail mcp config` prints this for the current
profile:

```json
{
  "mcpServers": {
    "pylota-mail": {
      "url": "https://mail.example.com/mcp",
      "headers": { "Authorization": "Bearer ${PYLOTA_MAIL_KEY}" }
    }
  }
}
```

Set `PYLOTA_MAIL_KEY` to the identity key in the environment the client runs in. The client sees
only the tools the key allows (for example `mail_search`, `mail_get_thread` and `mail_reply`). Send
tools require an `idempotency_key` argument. The server also offers a `mail_search_strategy` prompt
that teaches the model how to search. See [MCP server](reference/mcp.md) and
[Using it from an agent](guides/agents.md).

## Try it without sending real mail

A **test tenant** never sends mail outside the deployment
([FR-TEN-2](project/prd.md#61-tenancy-and-access)). Its keys start with `pmk_test_`, and its sends
go to a simulator instead of the internet. Create one with a platform key. If `PYLOTA_MAIL_KEY` still
holds the tenant key, unset it first, because it would outrank the platform key in your `default`
profile:

```bash
unset PYLOTA_MAIL_KEY
pmail --profile default tenants create --slug acme-test --name "Acme Car Hire (test)" --mode test
pmail --profile default keys create --level tenant --tenant acme-test --name acme-test-key \
  --permissions identities:read,identities:write,messages:read,messages:send,messages:write,search:read
```

Create an identity in it (as in [step 3](#3-create-an-identity)), then send to the simulator's
addresses:

```bash
pmail send --identity bookings.acme-test@agents.example \
  --to bounce@simulator.invalid --subject "Simulator test" --text "Hello" \
  --idempotency-key sim-bounce-1
```

| Recipient | Scripted outcome |
|---|---|
| `delivered@simulator.invalid` | Delivered (`message.delivered`) |
| `bounce@simulator.invalid` | A hard bounce (`message.bounced`, `bounce_type: hard`). Hard bounces create a suppression |
| `softbounce@simulator.invalid` | A soft bounce (`bounce_type: soft`) |
| `complaint@simulator.invalid` | A spam complaint (`message.complained`). Complaints create a permanent suppression |
| `deferred@simulator.invalid` | A temporary failure (`message.deferred`) |
| `reject@simulator.invalid` | Refused by the transport before sending (`message.rejected`) |
| `timeout@simulator.invalid` | No answer from the transport: `uncertain`, never resent ([G2](project/edge-cases.md)) |

Mail from a test tenant to an identity on the same deployment is delivered internally, with
`verdict: pass` and the flag `loopback` ([L3](project/edge-cases.md)), so you can test a full
send-and-reply loop between two identities. Any other recipient is refused with
`403 test_mode_recipient`. A live key cannot act on a test tenant, or the reverse
([L4](project/edge-cases.md)).

The `timeout@` address is the best way to practise handling an uncertain send. See
[Safe retries](guides/sending.md#safe-retries).

## If something goes wrong

| You see | Why | What to do |
|---|---|---|
| `401 unauthenticated` | No key, a malformed key, or the wrong deployment | Check `PYLOTA_MAIL_URL` and `PYLOTA_MAIL_KEY`, or the profile in `~/.config/pylota-mail/config.toml` |
| `403 permission_denied` | The key lacks a permission | `error.details.required` names it. Create a key that has it |
| `403 scope_denied` or a `404` with this service's error code | The resource is outside the key's tenant or identity | Use a key at the right level. A `404` deliberately does not say whether the resource exists |
| `400 idempotency_key_required` | A send without `Idempotency-Key` | Add the header (or `--idempotency-key`) |
| `409 identity_owner_required` | The identity has no accountable human | Set `--owner-name` and `--owner-email` |
| `409 idempotency_conflict` | The key was used for a different message | Use a new key for a new message |
| `403 test_mode_recipient` | A test tenant tried to send to a real address | Send to `*@simulator.invalid` or to an identity on this deployment |
| `ref:` finds nothing | The reference pack for that kind is off, or the reference is in an attachment whose text is not extracted yet | Enable `uk_vehicle` for plates and PCNs. Check the attachment's `text_status` |
| `ask` returns `insufficient_evidence` | The mailbox does not hold an answer | Check the `trace` to see what was searched |
| No webhook arrives | The endpoint failed or is not HTTPS | `pmail webhooks deliveries whk_…` shows each attempt and its error |

Every error has a `fix` field with one sentence on what to do, and a `request_id` to quote in bug
reports. The full list is in [Errors](reference/errors.md).
