# Agent signing keys and signed requests

How an agent proves who it is to people and systems outside email: **agent assertions** (signed JWTs
that any service can verify against a published key set) and **signed HTTP requests** (Web Bot Auth), so
a website can tell which agent made a request and that it came through this deployment.

| | |
|---|---|
| Requirements | FR-IDN-6 to FR-IDN-9 ([PRD](../prd.md)) |
| Edge cases | [O1–O13](../edge-cases.md) |
| Code | `crates/core/src/{jwk.rs, jwt.rs, httpsig.rs}`, `crates/worker/src/handlers/{identity_keys.rs, assertions.rs, http_signatures.rs, well_known.rs}` |
| Tables | D1 `identity_keys`, `key_tombstones`, `signing_keys` (purpose `web_bot_auth`) ([Data model](data-model.md)) |
| Crate | `ed25519-dalek =3.0.0` (the version `mail-auth =0.13.3` already depends on through its `rust-crypto` feature, read from the crates.io sparse index on 2026-10-09), declared with `default-features = false, features = ["zeroize"]`, plus `zeroize =1.9.0` for the unsealed seed buffer. `mail-auth` 0.13.3 depends on `ed25519-dalek` with its default features (`fast`, `zeroize`), and Cargo unifies features, so the `fast` precomputed tables are in the Worker bundle either way; spike S4 measures the bundle with them ([Rust workspace](rust-workspace.md#3-workspace-dependencies)) |
| External facts verified on 2026-10-09 | Cloudflare [Web Bot Auth](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/) (page updated 2026-10-08), which follows draft-meunier-http-message-signatures-directory-03 and draft-meunier-web-bot-auth-architecture-02; RFC 9421 (HTTP Message Signatures), RFC 8037 (EdDSA in JOSE and the Ed25519 JWK thumbprint, appendix A.3), RFC 7638 (JWK thumbprint), RFC 7517 (JWK), RFC 7519 (JWT) |

## 1. What it is for, and what it is not

| Use | Mechanism | Verified by |
|---|---|---|
| An agent signs up to, or calls, a third-party service and proves "I am `bookings.brightwell@pylotamail.com`, an agent of workspace Brightwell, with an accountable human" | **Agent assertion**: a short-lived JWT signed with the identity's own Ed25519 key | The service fetches the identity's JWKS and checks the signature, audience and expiry ([§4](#4-agent-assertions)) |
| An agent fetches web pages or calls web APIs, and the site wants to know it is a declared, accountable bot | **Signed HTTP request** (Web Bot Auth): RFC 9421 signature with a deployment key, with the agent's address in a signed `From` header | Any verifier of Web Bot Auth, including Cloudflare's verified bots when the operator has registered the directory ([§5](#5-signed-http-requests-web-bot-auth)) |

Not in scope: signing email bodies (DKIM already authenticates mail), client TLS certificates, exporting a
private key, or importing a key someone else generated. Private keys never leave the Worker.

## 2. Keys

| Property | Identity keys | Deployment keys (Web Bot Auth) |
|---|---|---|
| Algorithm | Ed25519 (`alg: "EdDSA"`, JWK `kty: "OKP"`, `crv: "Ed25519"`) | Ed25519 (`alg="ed25519"` in RFC 9421 parameters) |
| How many | One `active` key per identity, plus `retiring` keys during an overlap | One `active` key per deployment, plus `retiring` keys during an overlap |
| Stored in | `identity_keys` (`private_enc` sealed under `PM_MASTER_KEY`) | `signing_keys` with `purpose = 'web_bot_auth'` (seed sealed under `PM_MASTER_KEY` in `ciphertext`, public JWK in `public_jwk`) |
| Key ID | The base64url RFC 7638 thumbprint of the public JWK (RFC 8037 A.3), which is also the row ID | Same, stored in `signing_keys.kid` (43 characters, where the other purposes use one) |
| Created | Lazily, on the identity's first signing request, or explicitly with `POST …/keys` | Lazily by the Worker, on the first signing request or the first directory fetch while `PM_WEB_BOT_AUTH=on`, like the other `signing_keys` purposes (`INSERT … ON CONFLICT DO NOTHING`, then a re-read) |
| Rotated | `POST /v1/identities/{identity_id}/keys/rotate` | `POST /v1/platform/keys/web_bot_auth/rotate`; the previous key stays in the directory for 7 days (`verify_until`), or is deleted at once with `?revoke_previous=true` |

- **Generation.** 32 bytes from the platform CSPRNG become the Ed25519 seed (`SigningKey::from_bytes`).
  The seed is sealed at once with the `pm1` envelope ([Security](security.md)). It is zeroised in memory
  after each use (`zeroize`). A key created lazily by a signing request, or by `POST …/keys`, emits
  `identity.key_created`; the new key of a rotation emits `identity.key_rotated` instead.
- **States.** `active` (signs and is published) → `retiring` (published, does not sign, until
  `verify_until`) → `retired` (not published; the row is kept until identity deletion so its thumbprint
  is never reused). A rotation makes a new key `active` at once and the previous one `retiring` with
  `verify_until = now + PM_IDENTITY_KEY_OVERLAP_DAYS` (default 7). A revocation
  (`POST …/keys/{kid}/revoke`) moves any key straight to `retired`, for a suspected compromise ([O3](../edge-cases.md)).
- **Master-key rotation.** `pmail secrets rotate-master` re-seals `identity_keys.private_enc` and the
  `web_bot_auth` seeds like every other sealed value. Signatures and thumbprints do not change ([O8](../edge-cases.md)).
- **Paused, suspended or deleted identities** cannot sign. The order matches sends ([Outbound › Policy
  pipeline](outbound.md#policy-pipeline)): an identity of a suspended tenant gets `403 tenant_suspended`
  (checked first), a paused identity gets `409 identity_paused`, and a `deleting` or `deleted` identity gets
  `404 identity_not_found`, as on every other route. Their JWKS is withdrawn (`404`) while they are paused or suspended. This is the kill
  switch: a verifier that refetches the JWKS stops accepting the identity within the cache time
  ([O1](../edge-cases.md), [O7](../edge-cases.md)). Key management (`…/keys`, rotate, revoke) stays
  available while an identity is paused, so a suspected leak can be handled before it resumes.

## 3. Publication

### 3.1 Identity JWKS

`GET https://{PM_API_HOST}/.well-known/jwks/{identity_id}.json`, no authentication:

```json
{ "keys": [
  { "kty": "OKP", "crv": "Ed25519", "x": "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
    "kid": "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k", "alg": "EdDSA", "use": "sig" } ] }
```

- It lists `active` and `retiring` keys. `Cache-Control: public, max-age=300`. `Content-Type:
  application/jwk-set+json`.
- An unknown, deleted, paused or suspended identity gets the same `404 identity_not_found`, so the
  endpoint reveals nothing beyond what a valid assertion already names.
- Identity IDs are ULIDs and are never derived from addresses, so the endpoint cannot be used to test
  whether an address exists.

### 3.2 Web Bot Auth key directory

With `PM_WEB_BOT_AUTH=on`, `GET https://{PM_API_HOST}/.well-known/http-message-signatures-directory`
returns the deployment keys (`active` and `retiring`) as a JWKS, as the directory draft and Cloudflare's
page require:

- `Content-Type: application/http-message-signatures-directory+json`, `Cache-Control: max-age=86400`,
  served over HTTPS only.
- The response is **signed once per listed key**: `Signature-Input` with the component
  `("@authority";req)`, `alg="ed25519"`, `keyid` = the key's thumbprint, a 64-byte random `nonce`,
  `tag="http-message-signatures-directory"`, `created` = now and `expires` = now + 300, and the matching
  `Signature`. This stops anyone from mirroring the directory and registering it as theirs. At most three
  keys are listed (one active, two retiring), so the headers stay small ([O12](../edge-cases.md)).
- With `PM_WEB_BOT_AUTH=off` the path returns `404 key_not_found`.

Registering the directory with Cloudflare's verified-bot programme (dashboard, "Bot Submission Form",
verification method "Request Signature") is an **operator** decision documented in
[Self-hosting](../../self-hosting.md). Signatures verify for any Web Bot Auth verifier without it.

## 4. Agent assertions

### 4.1 Request

`POST /v1/identities/{identity_id}/assertions` with permission `identities:sign`. Each call mints a new
token, so an `Idempotency-Key` header is ignored and never recorded: a replay record would store the
token, which is never stored ([§4.2](#42-token)).

```json
{ "audience": "https://portal.supplier.example",
  "expires_in": 300,
  "nonce": "b3f1c2…",
  "ext": { "booking_ref": "BK-2291" } }
```

| Field | Rules |
|---|---|
| `audience` | Required. 1–256 characters of printable ASCII: a URL or an identifier the verifier expects ([O4](../edge-cases.md)) |
| `expires_in` | 60–600 seconds, default 300 ([O5](../edge-cases.md)) |
| `nonce` | Optional, 1–128 characters of printable ASCII, copied into the token for the verifier's challenge |
| `ext` | Optional object, at most 2 KB as JSON, placed under the `ext` claim. It cannot set registered or Pylota claims ([O6](../edge-cases.md)) |

### 4.2 Token

Header `{"alg":"EdDSA","typ":"agent-assertion+jwt","kid":"<thumbprint>"}`. Claims:

| Claim | Value |
|---|---|
| `iss` | `https://{PM_API_HOST}` |
| `sub` | The identity ID |
| `aud` | The requested audience |
| `iat`, `nbf` | Now |
| `exp` | Now + `expires_in` |
| `jti` | A new ULID |
| `email` | The identity's primary address |
| `email_verified` | `true`: mail to that address reaches this identity |
| `name` | The identity's display name |
| `org` | The workspace (tenant) name |
| `accountable_human` | `true` when the identity has an accountable owner (FR-IDN-2). The owner's name and address are never included |
| `ai_agent` | `true` |
| `nonce`, `ext` | When given |

Response `201`:

```json
{ "assertion": "eyJhbGciOiJFZERTQSIs…", "kid": "kPrK_qmx…", "expires_at": "2026-10-09T12:05:00Z",
  "jwks_uri": "https://api.pylotamail.com/.well-known/jwks/idn_01J9….json" }
```

The token is never stored or logged; only a count is kept (`usage_daily.metric = 'assertions'`).

### 4.3 How a verifier checks it

This is in the [Agents guide](../../guides/agents.md#verifying-an-assertion) for integrators, and in the
Rust SDK as `verify_assertion` ([Rust workspace §11](rust-workspace.md#11-the-rust-sdk-fr-sdk-1)) and the
CLI as `pmail assertions verify`:

1. Decode the header. `alg` must be `EdDSA` and `typ` must be `agent-assertion+jwt`. Reject anything else
   (no `none`, no algorithm switching).
2. `iss` must be an issuer you trust, for example `https://api.pylotamail.com`. Never fetch keys from a
   URL the token supplies.
3. Fetch `{iss}/.well-known/jwks/{sub}.json` (cache for at most 5 minutes) and pick the key whose `kid`
   matches. None found → reject.
4. Verify the Ed25519 signature over the JWS signing input.
5. `aud` must equal your own audience. Check `nbf` and `exp`, allowing 60 seconds of clock skew.
6. Keep `jti` until `exp` and reject a repeat.

## 5. Signed HTTP requests (Web Bot Auth)

### 5.1 Request

`POST /v1/identities/{identity_id}/http-signatures` with permission `identities:sign`. The Worker never
makes the request itself; it returns headers for the agent's HTTP client to attach. As for assertions,
an `Idempotency-Key` header is ignored and never recorded.

```json
{ "url": "https://www.brightwell.example/fleet/availability?from=2026-10-12",
  "method": "GET",
  "expires_in": 60,
  "components": ["@authority", "signature-agent", "from"] }
```

| Field | Rules |
|---|---|
| `url` | Required, `https` only, at most 2,048 characters. An IDN host is converted to its A-label for `@authority` ([O10](../edge-cases.md)) |
| `method` | Optional, upper-case token. Signed only if `@method` is in `components`, and then required (`400 invalid_request` without it) |
| `expires_in` | 30–300 seconds, default 60. Cloudflare notes that too short an expiry fails in transit ([O11](../edge-cases.md)) |
| `components` | Optional. Always includes `@authority`, `signature-agent` and `from`; may add `@method`, `@path` and `@query`. Header components other than those two are refused, and any component whose value is not ASCII is refused, because RFC 9421 and Cloudflare reject non-ASCII values |

Refused with `422 web_bot_auth_disabled` when `PM_WEB_BOT_AUTH=off`, and with `403 policy_denied` when
tenant policy `web_bot_auth.allowed` is `false` ([O9](../edge-cases.md), [O13](../edge-cases.md)).

### 5.2 Response

Response `200` (nothing is created or stored):

```json
{ "headers": {
    "Signature-Agent": "\"https://api.pylotamail.com\"",
    "From": "bookings.brightwell@pylotamail.com",
    "Signature-Input": "sig1=(\"@authority\" \"signature-agent\" \"from\");created=1791547200;expires=1791547260;keyid=\"poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U\";alg=\"ed25519\";nonce=\"e8N7S2MF…\";tag=\"web-bot-auth\"",
    "Signature": "sig1=:jdq0SqOwHdyHr9+r5jw3iYZH6aNGKijYp/EstF4RQTQdi5N5YYKrD+mCT1HA1nZDsi6nJKuHxUi/5Syp3rLWBA==:" },
  "expires_at": "2026-10-09T12:01:00Z" }
```

- `Signature-Agent` is a structured-field string, in double quotes, naming the deployment's origin. Its
  directory is at that origin's well-known path ([§3.2](#32-web-bot-auth-key-directory)).
- `From` carries the identity's primary address (RFC 9110 `From`: the address of whoever is responsible
  for the request). It is signed, so the site knows which agent made the request and how to reach its
  operator.
- The signature base is built by `core::httpsig::signature_base` exactly as RFC 9421 §2.5, and signed with
  the deployment's active key. `nonce` is 64 random bytes, base64.
- The count is kept as `usage_daily.metric = 'http_signatures'`. Signatures are not logged.

**Spike S13** checks the format against `https://crawltest.com/cdn-cgi/web-bot-auth`, which returns `401`
for a correctly formatted message with an unknown key, `200` for a known key that verifies and `400`
otherwise ([Web Bot Auth](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/),
read 2026-10-09). Pass: `401` before registration. Fallback: signed HTTP requests stay off in v1.0
(`PM_WEB_BOT_AUTH` cannot be turned on); assertions are unaffected.

## 6. Permissions, limits and plans

- New permission `identities:sign`. It is granted like any other permission (there are no wildcard
  permissions): a tenant key holds it when it is in the key's list, and an identity key holds it only when
  granted, for its own identity. Platform and partner keys cannot sign as an identity: creating a platform
  or partner key with `identities:sign` is refused with `400 invalid_request` and `details.reason =
  "permission_not_allowed_for_level"`. In the console, the owner's and admins' session principals hold it,
  so they can create keys that carry it.
- Console: owners and admins create, rotate and revoke identity keys on the identity page (sensitive
  actions: re-authentication and an audit row, `identity_key.create`, `identity_key.rotate` or
  `identity_key.revoke`; the API writes the same audit actions). Everyone in the workspace can see the key
  IDs and the JWKS link.
- Rate limit binding `RL_SIGN`: 600 signing calls a minute per identity, for assertions and HTTP signatures
  together. Over it: `429 rate_limited`.
- Signing is included in every plan and is not metered against an allowance.

## 7. API, MCP and CLI

| Endpoint | Permission | Result |
|---|---|---|
| `GET /v1/identities/{identity_id}/keys` | `identities:read` | Key IDs, states, `created_at`, `verify_until`, public JWKs (every key the identity has, `retired` ones included) |
| `POST /v1/identities/{identity_id}/keys` | `identities:write` | Creates the first key if none is active (`201`); `200` with the existing active key otherwise |
| `POST /v1/identities/{identity_id}/keys/rotate` | `identities:write` | New active key; the previous one becomes `retiring` |
| `POST /v1/identities/{identity_id}/keys/{kid}/revoke` | `identities:write` | The key becomes `retired` at once |
| `POST /v1/identities/{identity_id}/assertions` | `identities:sign` | §4 |
| `POST /v1/identities/{identity_id}/http-signatures` | `identities:sign` | §5 |
| `POST /v1/platform/keys/web_bot_auth/rotate` | `platform:ops` | Rotates the deployment key (`422 web_bot_auth_disabled` while `PM_WEB_BOT_AUTH=off`) |
| `GET /.well-known/jwks/{identity_id}.json` | none | §3.1 |
| `GET /.well-known/http-message-signatures-directory` | none | §3.2 |

MCP tools `mail_sign_assertion` and `mail_sign_http_request` (both `identities:sign`) mirror the two POST
endpoints. CLI: `pmail identity-keys list|create|rotate|revoke`, `pmail assertions create|verify`, and
`pmail http-sign`.

Events: `identity.key_created`, `identity.key_rotated` and `identity.key_revoked`, each with `identity_id`
and `kid` (`identity.key_rotated` also carries `previous_kid`). They are identity events, written after
the D1 change through the identity's mailbox like the other `identity.*` events. Errors: the new
`web_bot_auth_disabled` (422) and `policy_denied` (403); `key_not_found` (404), the existing code for a
missing key, also covers an unknown `kid` and the directory while it is off; plus the existing
`tenant_suspended` (checked first, before `identity_paused`), `identity_not_found`, `identity_paused`,
`invalid_request`, `permission_denied`, `scope_denied` and `rate_limited`.

## 8. Data model

```sql
-- D1: identity_keys (replaces the earlier P1 sketch)
CREATE TABLE identity_keys (
  id           TEXT PRIMARY KEY,                    -- RFC 7638 thumbprint, base64url
  identity_id  TEXT NOT NULL REFERENCES identities(id),
  tenant_id    TEXT NOT NULL,
  alg          TEXT NOT NULL CHECK (alg = 'EdDSA'),
  public_jwk   TEXT NOT NULL,
  private_enc  BLOB NOT NULL,                       -- pm1 envelope of the 32-byte seed
  status       TEXT NOT NULL CHECK (status IN ('active','retiring','retired')),
  created_at   INTEGER NOT NULL,
  verify_until INTEGER,                             -- set when retiring
  retired_at   INTEGER
);
CREATE UNIQUE INDEX identity_keys_one_active ON identity_keys (identity_id) WHERE status = 'active';

-- D1: signing_keys gains a purpose and a public key
--   purpose CHECK (purpose IN ('thread','link','cursor','web_bot_auth'))
--   kid     CHECK ((purpose = 'web_bot_auth' AND length(kid) = 43) OR (purpose <> 'web_bot_auth' AND length(kid) = 1))
--   public_jwk TEXT   -- set for web_bot_auth only

-- D1: thumbprints that must never be published again
CREATE TABLE key_tombstones (
  kid        TEXT PRIMARY KEY,                      -- RFC 7638 thumbprint of a deleted identity key
  deleted_at INTEGER NOT NULL
);
```

`usage_daily` gains the metrics `assertions` and `http_signatures`. Identity erasure (and tenant erasure,
for every identity of the tenant) deletes the identity's `identity_keys` rows and records each thumbprint
in `key_tombstones`, a separate table that does for key IDs what `address_tombstones` does for addresses:
key generation refuses a thumbprint found there and draws a new seed, so a deleted key ID is never
published again.

## 9. Configuration

| Name | Default | Meaning |
|---|---|---|
| `PM_WEB_BOT_AUTH` | `off` | `on` publishes the directory and allows signed HTTP requests (after S13 passes) |
| `PM_IDENTITY_KEY_OVERLAP_DAYS` | `7` | How long a retiring identity key stays published |
| Binding `RL_SIGN` | 600 per 60 s | Keyed by identity ID |
| Tenant policy `web_bot_auth.allowed` | `false` | A tenant must opt in before its identities can sign HTTP requests |

## 10. Security and privacy

- Private keys are generated, sealed, used and zeroised inside the Worker. No API returns them.
- An assertion discloses the identity's address, display name and workspace name to its audience, which is
  the point of it. It never contains the owner's personal data.
- Web Bot Auth attributes requests to the deployment and, through `From`, to an identity. An identity
  whose agent misbehaves on the web is paused like any other abuse case; pausing withdraws its JWKS and
  stops new signatures at once.
- Replay: assertions carry `jti` and short expiry; HTTP signatures carry `nonce`, `created` and `expires`.
  Verifiers keep the replay caches.

## 11. Tests

| Test | Covers |
|---|---|
| `core::jwk::thumbprint_rfc8037_vector` | The RFC 8037 appendix A.3 thumbprint vector |
| `core::jwt::eddsa_rfc8037_vector` | The RFC 8037 appendix A.4 signing vector |
| `core::httpsig::signature_base_rfc9421` | Signature bases match the RFC 9421 examples; an IDN host becomes its A-label in `@authority`; non-ASCII components refused ([O10](../edge-cases.md)) |
| `it::identity_keys::lazy_create_and_rotate` | First sign creates a key; rotation keeps the old key in the JWKS until `verify_until` ([O2](../edge-cases.md)) |
| `it::identity_keys::revoke_removes_from_jwks` | Revoked key disappears from the JWKS at once ([O3](../edge-cases.md)) |
| `it::identity_keys::paused_withdraws_jwks` | Paused identity: `409` on sign, `404` on JWKS ([O1](../edge-cases.md)) |
| `it::assertions::claims_and_limits` | Audience, expiry and `ext` rules ([O4](../edge-cases.md), [O5](../edge-cases.md), [O6](../edge-cases.md)) |
| `it::assertions::sdk_verifies` | The SDK verifier accepts a fresh token and rejects a wrong audience, an expired token, an unknown kid and `alg: none` |
| `it::assertions::erasure_tombstones_kid` | Identity erasure deletes keys and the kid is never published again ([O7](../edge-cases.md)) |
| `it::secrets::rotate_master_reseals_identity_keys` | Signatures before and after a master rotation verify with the same public key ([O8](../edge-cases.md)) |
| `it::http_signatures::disabled_and_policy` | `PM_WEB_BOT_AUTH=off` → `422`; tenant not opted in → `403` ([O9](../edge-cases.md), [O13](../edge-cases.md)) |
| `it::http_signatures::expiry_bounds` | 29 s and 301 s refused ([O11](../edge-cases.md)) |
| `it::well_known::directory_signed_per_key` | One signature per listed key, tag and components as §3.2, overlap keeps two keys ([O12](../edge-cases.md)) |
| Spike S13 | crawltest.com answers `401` (well-formed, unknown key) |
