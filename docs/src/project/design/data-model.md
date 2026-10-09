# Data model

Binding for implementation. Migrations live in `migrations/d1/` (D1) and in
`crates/worker/src/mailbox/schema/` (Durable Object SQLite, applied on wake). This page is the source
of truth for both.

## Conventions

- **IDs** are a type prefix, an underscore, and a [ULID](https://github.com/ulid/spec) (26 characters,
  Crockford base32, upper case). For example: `msg_01J9Z3K8V4QW7X2M5N6P8R0T1Y`. ULIDs come from the
  platform clock and RNG (never `SystemTime` in wasm). They are monotonic within a millisecond per isolate.

  | Prefix | Entity | Prefix | Entity |
  |---|---|---|---|
  | `ten_` | tenant | `whk_` | webhook endpoint |
  | `idn_` | identity | `dlv_` | webhook delivery |
  | `adr_` | address | `evt_` | event |
  | `dom_` | domain | `key_` | API key |
  | `thr_` | thread | `era_` | erasure request |
  | `msg_` | message | `exp_` | export |
  | `att_` | attachment | `job_` | internal job |
  | `aud_` | audit entry | `req_` | request ID |
  | `usr_` | console user | `inv_` | invitation |
  | `dlq_` | dead-letter item | `hld_` | quota hold |
  | `prb_` | alignment probe | | |

- **Times** are stored as Unix milliseconds (`INTEGER`) and exposed in the API as RFC 3339 UTC strings.
- **Email addresses** are stored lower-cased, with the domain as an IDNA A-label (punycode). Local parts
  keep dots (no provider-specific folding, [A1](../edge-cases.md)).
- **JSON columns** end in `_json` and hold values validated by `crates/api-types` before writing.
- **Enumerations** are `TEXT` with a `CHECK` constraint, so an invalid state fails at write time.
- D1 runs with `PRAGMA foreign_keys = ON`. Durable Object SQLite enables it in each migration.

## 1. D1 control plane

```sql
-- migrations/d1/0001_init.sql
PRAGMA foreign_keys = ON;

CREATE TABLE tenants (
  id               TEXT PRIMARY KEY,                       -- ten_
  slug             TEXT NOT NULL UNIQUE,                   -- ^[a-z0-9][a-z0-9-]{1,31}$
  name             TEXT NOT NULL,
  mode             TEXT NOT NULL CHECK (mode IN ('live','test')),
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','suspended','erasing','erased')),
  suspended_at     INTEGER,
  address_suffix   TEXT NOT NULL,                          -- '' (default tenant) or '.' || slug
  timezone         TEXT NOT NULL DEFAULT 'UTC',            -- IANA name
  policy_json      TEXT NOT NULL,                          -- TenantPolicy (see configuration.md)
  quota_do_id      TEXT NOT NULL,                          -- TenantQuota Durable Object id
  require_two_factor      INTEGER NOT NULL DEFAULT 0       -- members need two-step verification (console)
                          CHECK (require_two_factor IN (0,1)),
  onboarding_dismissed_at INTEGER,                         -- first-run checklist dismissed (Cloud sign-up § 8)
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX tenants_suffix ON tenants(address_suffix) WHERE address_suffix <> '';

CREATE TABLE domains (
  id                    TEXT PRIMARY KEY,                  -- dom_
  tenant_id             TEXT REFERENCES tenants(id),       -- NULL only for the platform domain
  name                  TEXT NOT NULL UNIQUE,              -- A-label, lower case
  kind                  TEXT NOT NULL CHECK (kind IN ('platform','zone','delegated','external')),
  method                TEXT NOT NULL                      -- connection method; fixes kind, inbound, transport
                        CHECK (method IN ('platform','cloudflare_zone','nameservers','dns_records',
                                          'send_only','smtp_relay','delegated_subdomain')),
  zone_id               TEXT,                              -- Cloudflare zone (platform, zone, delegated)
  is_apex               INTEGER NOT NULL CHECK (is_apex IN (0,1)),
  routing_mode          TEXT NOT NULL CHECK (routing_mode IN ('catch_all','literal','forward')),
  inbound               TEXT NOT NULL CHECK (inbound IN ('routing','ses','forward','none')),
  transport             TEXT NOT NULL CHECK (transport IN ('cloudflare','ses','smtp')),
  reply_token           TEXT NOT NULL CHECK (reply_token IN ('subaddress','none')),
  receiving             INTEGER NOT NULL CHECK (receiving IN (0,1)),
  sending               INTEGER NOT NULL CHECK (sending IN (0,1)),
  state                 TEXT NOT NULL
                        CHECK (state IN ('pending','verifying','healthy','degraded','failing',
                                         'suspended','removing','removed')),
  state_reason          TEXT,                              -- machine code, e.g. dkim_missing
  state_changed_at      INTEGER NOT NULL,
  ownership_token       TEXT,                              -- value for _pylota-mail TXT challenge
  ownership_verified_at INTEGER,
  expected_ns_json      TEXT,                              -- nameservers seen at verification
  rdap_fingerprint      TEXT,                              -- hash of registrar + registrant handle + created
  event_subscription_id TEXT,                              -- Email Sending → pm-delivery-events
  ses_identity          TEXT,                              -- SES email identity name, if inbound or transport = ses
  ses_region            TEXT,                              -- set when inbound or transport is ses
  mail_from_domain      TEXT,                              -- pm-bounce.{domain}, the custom MAIL FROM (SES transport)
  smtp_sealed           BLOB,                              -- smtp_relay: pm1 envelope of {host, port, username,
                                                           -- password, probe_from}
  smtp_pending_sealed   BLOB,                              -- values from PATCH waiting for a passing probe
                                                           -- (pm1 envelope, aad column smtp_pending_sealed)
  probe_last_at         INTEGER,                           -- transport = smtp: last alignment probe
  probe_last_json       TEXT,                              -- {result, dkim_d, dmarc, from_unchanged, at}
  records_json          TEXT NOT NULL DEFAULT '[]',        -- records to publish, with their last observed state;
                                                           -- each carries name (FQDN), host (relative to the
                                                           -- registrable domain), purpose and required
  monitor_do_id         TEXT NOT NULL,                     -- DomainMonitor Durable Object id; '' until the
                                                           -- every-minute cron mints it (rows written by the CLI)
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX domains_tenant ON domains(tenant_id, state);

CREATE TABLE identities (
  id                 TEXT PRIMARY KEY,                     -- idn_
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  username           TEXT NOT NULL,                        -- ^[a-z0-9][a-z0-9._-]{0,23}$
  display_name       TEXT NOT NULL,                        -- ≤ 78 chars, no CR/LF
  purpose            TEXT,                                 -- free tag, e.g. bookings
  client_id          TEXT,                                 -- integrator's idempotent create key
  client_fingerprint TEXT,                                 -- sha256 of the canonical create body
  owner_name         TEXT,                                 -- accountable human (FR-IDN-2)
  owner_email        TEXT,
  signature_text     TEXT,
  signature_html     TEXT,                                 -- sanitised on write
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','paused','deleting','deleted')),
  pause_reason       TEXT CHECK (pause_reason IN ('manual','abuse_threshold','tenant_suspended')),
  send_policy_json   TEXT NOT NULL DEFAULT '{}',
  metadata_json      TEXT NOT NULL DEFAULT '{}',           -- ≤ 16 string keys, ≤ 512 bytes each
  mailbox_do_id      TEXT NOT NULL,                        -- IdentityMailbox Durable Object id
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX identities_client   ON identities(tenant_id, client_id) WHERE client_id IS NOT NULL;
CREATE UNIQUE INDEX identities_username ON identities(tenant_id, username) WHERE status <> 'deleted';
CREATE INDEX identities_tenant ON identities(tenant_id, status);

-- The address directory: every inbound message is routed with one lookup on addresses.address.
CREATE TABLE addresses (
  id              TEXT PRIMARY KEY,                        -- adr_
  address         TEXT NOT NULL,                           -- local@domain, lower case, A-label
  local_part      TEXT NOT NULL,
  domain_id       TEXT NOT NULL REFERENCES domains(id),
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  identity_id     TEXT NOT NULL REFERENCES identities(id),
  role            TEXT NOT NULL CHECK (role IN ('primary','alias')),
  status          TEXT NOT NULL CHECK (status IN ('pending','active','retiring','retired')),
  routing_rule_id TEXT,                                    -- Cloudflare literal rule (routing_mode = literal)
  retire_at       INTEGER,                                 -- when status = retiring
  retired_at      INTEGER,
  ses_bounce_rule TEXT,                                    -- pm-retired-{n} holding this retired address (inbound = ses)
  forwarding      TEXT                                     -- NULL unless the domain's inbound = forward
                  CHECK (forwarding IN ('unverified','ok','failed')),
  forwarding_checked_at INTEGER,                           -- last forwarding test result or forwarded message
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX addresses_address     ON addresses(address);
CREATE UNIQUE INDEX addresses_one_primary ON addresses(identity_id) WHERE role = 'primary';
CREATE INDEX addresses_identity ON addresses(identity_id, status);
CREATE INDEX addresses_retiring ON addresses(status, retire_at) WHERE status = 'retiring';

-- Deleted or erased addresses can never be reassigned (A5). Stored as a keyed hash, so an erased
-- address is not kept in clear.
CREATE TABLE address_tombstones (
  address_hash TEXT PRIMARY KEY,                           -- hex HMAC-SHA256(PM_HASH_KEY, address)
  identity_id  TEXT,                                       -- the only identity allowed to reclaim it
  reason       TEXT NOT NULL CHECK (reason IN ('deleted','erased')),
  created_at   INTEGER NOT NULL
);

CREATE TABLE api_keys (
  id                TEXT PRIMARY KEY,                      -- key_
  lookup            TEXT NOT NULL UNIQUE,                  -- 12 chars, embedded in the secret
  hash              TEXT NOT NULL,                         -- hex HMAC-SHA256(PM_KEY_PEPPER, secret)
  prev_hash         TEXT,                                  -- previous secret during rotation overlap
  prev_expires_at   INTEGER,
  name              TEXT NOT NULL,
  level             TEXT NOT NULL CHECK (level IN ('platform','tenant','identity')),
  tenant_id         TEXT REFERENCES tenants(id),
  identity_id       TEXT REFERENCES identities(id),
  mode              TEXT NOT NULL CHECK (mode IN ('live','test')),
  permissions_json  TEXT NOT NULL,                         -- array of permission strings
  created_by_key_id TEXT,
  expires_at        INTEGER,
  revoked_at        INTEGER,
  last_used_at      INTEGER,                               -- updated at most once per minute
  created_at        INTEGER NOT NULL,
  CHECK ((level = 'platform' AND tenant_id IS NULL AND identity_id IS NULL)
      OR (level = 'tenant'   AND tenant_id IS NOT NULL AND identity_id IS NULL)
      OR (level = 'identity' AND tenant_id IS NOT NULL AND identity_id IS NOT NULL))
);
CREATE INDEX api_keys_tenant ON api_keys(tenant_id);

CREATE TABLE webhook_endpoints (
  id                     TEXT PRIMARY KEY,                 -- whk_
  tenant_id              TEXT REFERENCES tenants(id),      -- NULL = platform-wide endpoint
  url                    TEXT NOT NULL,                    -- https only, validated (SSRF rules)
  description            TEXT,
  event_types_json       TEXT NOT NULL,                    -- ["*"] or explicit list
  identity_ids_json      TEXT,                             -- optional filter
  enabled                INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  disabled_reason        TEXT,                             -- manual | failing
  secret_enc             TEXT NOT NULL,                    -- AES-256-GCM(PM_MASTER_KEY), base64
  prev_secret_enc        TEXT,
  prev_secret_expires_at INTEGER,
  consecutive_failures   INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE INDEX webhook_endpoints_tenant ON webhook_endpoints(tenant_id, enabled);

CREATE TABLE webhook_deliveries (
  id              TEXT PRIMARY KEY,                        -- dlv_
  endpoint_id     TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  tenant_id       TEXT,
  event_id        TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  attempt         INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('succeeded','failed','dead')),
  http_status     INTEGER,
  error           TEXT,                                    -- machine code: timeout, tls, dns, status_5xx, ...
  duration_ms     INTEGER,
  next_attempt_at INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX webhook_deliveries_attempt ON webhook_deliveries(endpoint_id, event_id, attempt);
CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at DESC);

-- Where each event's payload lives (owner object), for replay. Payloads stay in the owner.
CREATE TABLE event_index (
  id           TEXT PRIMARY KEY,                           -- evt_
  tenant_id    TEXT,
  identity_id  TEXT,
  type         TEXT NOT NULL,
  owner_kind   TEXT NOT NULL CHECK (owner_kind IN ('mailbox','domain','job','platform')),
  owner_id     TEXT NOT NULL,                              -- Durable Object id, or 'platform'
  payload_json TEXT,                                       -- only for owner_kind = 'platform'
  occurred_at  INTEGER NOT NULL
);
CREATE INDEX event_index_tenant_time ON event_index(tenant_id, occurred_at);

CREATE TABLE suppressions (
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  address_hash      TEXT NOT NULL,                         -- HMAC(PM_HASH_KEY, address)
  address_hint      TEXT NOT NULL,                         -- masked, e.g. j***@example.com
  reason            TEXT NOT NULL
                    CHECK (reason IN ('hard_bounce','complaint','unsubscribe','manual','provider')),
  source_message_id TEXT,
  note              TEXT,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER,                               -- NULL = permanent
  PRIMARY KEY (tenant_id, address_hash)
);

CREATE TABLE sender_lists (
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  direction  TEXT NOT NULL CHECK (direction IN ('receive','send')),
  kind       TEXT NOT NULL CHECK (kind IN ('allow','block')),
  entry      TEXT NOT NULL,                                -- user@example.com or @example.com
  note       TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, direction, kind, entry)
);

CREATE TABLE jobs (
  id                TEXT PRIMARY KEY,                      -- job_
  tenant_id         TEXT,
  kind              TEXT NOT NULL
                    CHECK (kind IN ('erasure','retention','export','reembed','reparse','reindex','domain_remove',
                                    'backup')),
  status            TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','canceled')),
  runner_do_id      TEXT NOT NULL,                         -- JobRunner Durable Object id
  params_json       TEXT NOT NULL,
  result_json       TEXT,
  created_by_key_id TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  completed_at      INTEGER
);
CREATE INDEX jobs_tenant ON jobs(tenant_id, kind, created_at DESC);

CREATE TABLE erasure_requests (
  id                   TEXT PRIMARY KEY,                   -- era_
  tenant_id            TEXT NOT NULL,
  job_id               TEXT NOT NULL REFERENCES jobs(id),
  scope                TEXT NOT NULL
                       CHECK (scope IN ('message','thread','counterparty','identity','tenant')),
  identity_id          TEXT,
  target_id            TEXT,                               -- msg_/thr_ for message and thread scope
  counterparty_hash    TEXT,                               -- HMAC of the counterparty address
  reason               TEXT NOT NULL,
  status               TEXT NOT NULL
                       CHECK (status IN ('queued','running','completed','completed_with_holds','failed')),
  receipt_json         TEXT,
  created_by_key_id    TEXT,
  created_at           INTEGER NOT NULL,
  completed_at         INTEGER
);

CREATE TABLE exports (
  id            TEXT PRIMARY KEY,                          -- exp_
  tenant_id     TEXT NOT NULL,
  job_id        TEXT NOT NULL REFERENCES jobs(id),
  scope         TEXT NOT NULL CHECK (scope IN ('counterparty','identity')),
  status        TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','expired')),
  r2_key        TEXT,
  size          INTEGER,
  expires_at    INTEGER,                                   -- download available for 7 days
  created_at    INTEGER NOT NULL
);

-- Idempotency for non-mail POSTs (mail sends are idempotent inside the mailbox).
CREATE TABLE idempotency_records (
  scope           TEXT NOT NULL,                           -- tenant_id or 'platform'
  idem_key        TEXT NOT NULL,                           -- ≤ 255 printable ASCII
  method          TEXT NOT NULL,
  path            TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,                           -- sha256(method, path, canonical JSON body)
  status          TEXT NOT NULL CHECK (status IN ('in_progress','completed')),
  response_status INTEGER,
  response_body   TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,                        -- created_at + 30 days
  PRIMARY KEY (scope, idem_key)
);

CREATE TABLE identity_keys (                               -- P1: agent signing keys (JWKS)
  id          TEXT PRIMARY KEY,                            -- kid
  identity_id TEXT NOT NULL REFERENCES identities(id),
  tenant_id   TEXT NOT NULL,
  alg         TEXT NOT NULL CHECK (alg = 'EdDSA'),
  public_jwk  TEXT NOT NULL,
  private_enc TEXT NOT NULL,                               -- AES-256-GCM(PM_MASTER_KEY)
  status      TEXT NOT NULL CHECK (status IN ('active','retired')),
  created_at  INTEGER NOT NULL,
  retired_at  INTEGER
);

CREATE TABLE usage_daily (
  tenant_id TEXT NOT NULL,
  day       TEXT NOT NULL,                                 -- YYYY-MM-DD in UTC
  metric    TEXT NOT NULL,                                 -- inbound, outbound, sends, triage, search, agentic,
                                                           -- ai_neurons, storage_bytes
  value     INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, day, metric)
);

CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,                           -- aud_
  tenant_id    TEXT,
  actor_key_id TEXT,                                       -- the API key that acted, if any
  actor_user_id TEXT,                                      -- usr_: the person, for console actions
  action       TEXT NOT NULL,                              -- e.g. key.create, quarantine.release
  target_type  TEXT,
  target_id    TEXT,
  details_json TEXT,                                       -- never message content or clear addresses
  request_id   TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX audit_log_tenant ON audit_log(tenant_id, created_at DESC);
CREATE INDEX audit_log_actor  ON audit_log(actor_key_id, created_at DESC);   -- ?actor_key_id= filter (J6)

-- Thread-token, signed-link and search-cursor keys. Generated by the Worker (32 bytes from platform::Rng),
-- never by the operator and never readable through any API or the CLI. Sealed under PM_MASTER_KEY in the
-- encryption envelope of Security § 7.2 with associated data "pm1|signing_keys|ciphertext|{purpose}:{kid}".
CREATE TABLE signing_keys (
  purpose      TEXT NOT NULL CHECK (purpose IN ('thread','link','cursor')),
  kid          TEXT NOT NULL CHECK (length(kid) = 1),      -- one Crockford base32 character, lower case
  ciphertext   BLOB NOT NULL,                              -- pm1.{kid}.{nonce}.{ciphertext} as UTF-8 bytes
  created_at   INTEGER NOT NULL,
  verify_until INTEGER,                                    -- NULL for the current key of its purpose
  PRIMARY KEY (purpose, kid)
);
CREATE UNIQUE INDEX signing_keys_current ON signing_keys(purpose) WHERE verify_until IS NULL;

-- Dead-letter records (Observability § 8). Written by the dead-letter consumers, read and redriven
-- through GET /v1/platform/dlq and POST /v1/platform/dlq/{id}/redrive (platform:ops).
CREATE TABLE dlq_items (
  id            TEXT PRIMARY KEY,                          -- dlq_
  queue         TEXT NOT NULL
                CHECK (queue IN ('pm-inbound','pm-outbound','pm-delivery-events','pm-webhooks','pm-index')),
  message_id    TEXT NOT NULL,                             -- Cloudflare queue message id
  body_json     TEXT NOT NULL,                             -- the pointer as received (bodies stay under 4 KB)
  body_sha256   TEXT NOT NULL,
  tenant_id     TEXT,                                      -- named by the body, if any
  kind          TEXT,                                      -- the body's "kind", if any
  first_seen_at INTEGER NOT NULL,
  redriven_at   INTEGER,
  redrive_count INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX dlq_items_message ON dlq_items(queue, message_id);
CREATE INDEX dlq_items_open ON dlq_items(queue, first_seen_at) WHERE redriven_at IS NULL;

-- Exactly-once ingestion of mail received through Amazon SES (Domains on any DNS host § 4.5). The SNS push
-- and the SQS backstop both INSERT OR IGNORE here; only an inserted row enqueues an InboundPointer.
CREATE TABLE ses_ingest (
  object_key  TEXT NOT NULL,                               -- S3 key under in/ (= SES mail.messageId)
  recipient   TEXT NOT NULL,                               -- normalised envelope recipient
  received_at INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('queued','held','done','dropped','lost')),
  done_at     INTEGER,
  PRIMARY KEY (object_key, recipient)
);
CREATE INDEX ses_ingest_pending ON ses_ingest(status, received_at) WHERE status IN ('queued','held');

-- ---------- Console: people, workspaces membership, sessions ----------
CREATE TABLE users (
  id                    TEXT PRIMARY KEY,                  -- usr_
  email                 TEXT NOT NULL UNIQUE,              -- lower case; the sign-in address
  name                  TEXT,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  last_tenant_id        TEXT,                              -- workspace used last (Cloud sign-up § 7)
  terms_version         TEXT,                              -- PM_TERMS_VERSION accepted at sign-up
  terms_accepted_at     INTEGER,
  totp_sealed           BLOB,                              -- pm1 envelope of the 20-byte TOTP secret
  totp_enabled_at       INTEGER,
  totp_last_step        INTEGER,                           -- last accepted time step, against replay
  recovery_codes_sealed BLOB,                              -- pm1 envelope of [{ "hash": SHA-256(code), "used_at": null }]
  totp_window_start     INTEGER,                           -- start of the current one-minute attempt window
  totp_window_count     INTEGER NOT NULL DEFAULT 0,        -- two-step attempts in that window (at most 5)
  totp_failures         INTEGER NOT NULL DEFAULT 0,        -- failed codes in a row; 10 sets totp_locked_until
  totp_locked_until     INTEGER,                           -- two-step sign-in locked until (15 minutes)
  created_at            INTEGER NOT NULL,
  last_login_at         INTEGER
);

CREATE TABLE members (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  role        TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);
CREATE UNIQUE INDEX members_one_owner ON members(tenant_id) WHERE role = 'owner';
CREATE INDEX members_user ON members(user_id);

CREATE TABLE invitations (
  id          TEXT PRIMARY KEY,                            -- inv_
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  email       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin','member','viewer')),
  token_hash  TEXT NOT NULL UNIQUE,                        -- HMAC(link key {key_kid}, token)
  key_kid     TEXT NOT NULL,                               -- signing_keys kid (purpose 'link') of token_hash
  invited_by  TEXT NOT NULL REFERENCES users(id),
  status      TEXT NOT NULL CHECK (status IN ('pending','accepted','revoked','expired')),
  expires_at  INTEGER NOT NULL,                            -- created + 7 days
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX invitations_pending ON invitations(tenant_id, email) WHERE status = 'pending';

CREATE TABLE login_tokens (                                -- magic links and six-digit codes
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,                        -- HMAC(link key {key_kid}, link token)
  code_hash   TEXT NOT NULL,                               -- HMAC(link key {key_kid}, email || code)
  key_kid     TEXT NOT NULL,                               -- signing_keys kid (purpose 'link')
  attempts    INTEGER NOT NULL DEFAULT 0,                  -- ≤ 10, then the token is burned
  expires_at  INTEGER NOT NULL,                            -- created + 10 minutes
  used_at     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX login_tokens_email ON login_tokens(email, created_at);

CREATE TABLE sessions (
  id_hash         TEXT PRIMARY KEY,                        -- HMAC(link key {key_kid}, cookie value)
  key_kid         TEXT NOT NULL,                           -- signing_keys kid (purpose 'link') of id_hash
  user_id         TEXT NOT NULL REFERENCES users(id),
  tenant_id       TEXT REFERENCES tenants(id),             -- active workspace
  csrf_secret     TEXT NOT NULL,
  authenticated_at INTEGER NOT NULL,                       -- for "signed in within 10 minutes" checks
  last_seen_at    INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,                        -- rolling 7 days, absolute 30 days
  revoked_at      INTEGER,
  user_agent_hint TEXT                                     -- browser family only
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Google and GitHub sign-in (Cloud sign-up § 4). A verified provider address links to the existing user.
CREATE TABLE oauth_identities (
  provider      TEXT NOT NULL CHECK (provider IN ('google','github')),
  subject       TEXT NOT NULL,                             -- Google sub, GitHub numeric id
  user_id       TEXT NOT NULL REFERENCES users(id),
  email_at_link TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX oauth_identities_user ON oauth_identities(user_id);

CREATE TABLE oauth_states (                                -- one row per started OAuth flow, single use
  state_hash  TEXT PRIMARY KEY,                            -- HMAC(link key {key_kid}, state)
  cookie_hash TEXT NOT NULL,                               -- HMAC(link key {key_kid}, __Host-pm_oauth value)
  key_kid     TEXT NOT NULL,                               -- signing_keys kid (purpose 'link') of both hashes
  provider    TEXT NOT NULL CHECK (provider IN ('google','github')),
  intent      TEXT NOT NULL CHECK (intent IN ('sign_in','sign_up','reauth')),
  pkce_sealed BLOB NOT NULL,                               -- pm1 envelope of the PKCE verifier
  nonce       TEXT,                                        -- Google only
  next_path   TEXT,                                        -- validated next (Cloud sign-up § 7)
  plan        TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,                            -- created + 10 minutes
  used_at     INTEGER
);

CREATE TABLE waitlist (                                    -- PM_SIGNUP = waitlist (Cloud sign-up § 6.1)
  email        TEXT PRIMARY KEY,                           -- needed to send the invitation; deleted as in the notes
  plan         TEXT,                                       -- plan of interest
  created_at   INTEGER NOT NULL,
  confirmed_at INTEGER,                                    -- double opt-in link used
  invited_at   INTEGER,                                    -- sign-up link sent, valid 7 days
  invite_token_hash TEXT UNIQUE,                           -- HMAC(link key {key_kid}, sign-up link token)
  key_kid      TEXT                                        -- signing_keys kid (purpose 'link') of invite_token_hash
);

-- ---------- Plans and billing ----------
CREATE TABLE billing_accounts (
  tenant_id            TEXT PRIMARY KEY REFERENCES tenants(id),
  mode                 TEXT NOT NULL CHECK (mode IN ('metered','exempt','disabled')),
  plan_id              TEXT NOT NULL DEFAULT 'free',       -- key into PM_PLAN_CATALOG
  status               TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','trialing','past_due','canceled','incomplete')),
  topups_json          TEXT NOT NULL DEFAULT '{}',         -- {"inboxes":2,"sends":5,"triage":0} units
  period_start         INTEGER NOT NULL,                   -- current allowance period
  period_end           INTEGER NOT NULL,
  grace_until          INTEGER,                            -- past_due grace end (7 days)
  stripe_customer_id   TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  updated_at           INTEGER NOT NULL
);

CREATE TABLE billing_events (                              -- Stripe webhook deduplication and audit
  id           TEXT PRIMARY KEY,                           -- Stripe event id (evt_…)
  type         TEXT NOT NULL,
  tenant_id    TEXT,
  received_at  INTEGER NOT NULL,
  processed_at INTEGER,
  outcome      TEXT                                        -- applied | ignored_stale | error:<code>
);

CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
```

### Notes

- **Directory lookups.** `email()` runs one query per message:

  ```sql
  SELECT a.status, a.identity_id, a.tenant_id, i.mailbox_do_id, i.status, t.status, t.mode
  FROM addresses a
  JOIN identities i ON i.id = a.identity_id
  JOIN tenants t ON t.id = a.tenant_id
  WHERE a.address = ?1
  ```

  If nothing matches, it checks `address_tombstones`, so that erased and deleted addresses get the
  same `550 5.1.1` as unknown ones.
- **Address uniqueness is global.** A retired address keeps its row, so it can never be reassigned.
  Deleting an identity moves its address rows to `address_tombstones` and removes them from `addresses`.
- **Suppressions store only a keyed hash** and a masked hint. A suppression outlives counterparty
  erasure, because it records an objection to contact (UK and EU GDPR Art. 21). The privacy guide says so.
- **Signing keys.** `signing_keys` holds the keyring for thread tokens ([Threading](threading.md#24-key-rotation)),
  signed links ([Security › Signed links](security.md#73-signed-links)) and search cursors
  ([Search › Cursors](search.md#58-cursors-and-as_of-pinning)). `link` signs download links, console
  sign-in, invitation and session tokens and OAuth state hashes; it no longer signs cursors. The Worker
  creates the first key of each purpose on first use (`INSERT … ON CONFLICT DO NOTHING`, then a re-read,
  so two isolates racing end with one key).
  `POST /v1/platform/keys/{purpose}/rotate` inserts a new current key and sets `verify_until` on the old
  one: 90 days for `thread`, 7 days for `link` (the longest link lifetime: `link_ttl_hours` ≤ 168 and
  export links 7 days), 24 hours for `cursor` (the cursor lifetime). With `?revoke_previous=true` the
  old row is deleted in the same D1 batch instead, so what it signed stops verifying at once. Rows past
  `verify_until` are deleted by the global retention job. Isolates cache the opened keyring for 5 minutes
  and re-read it at once when a token names an unknown kid (at most once a minute per isolate).
- **Sealed values.** These columns hold the pm1 envelope of
  [Security § 7.2](security.md#72-encryption-envelope) under `PM_MASTER_KEY`, with associated data
  `pm1|{table}|{column}|{row id}` (for example `pm1|domains|smtp_sealed|{domain_id}`):
  `webhook_endpoints.secret_enc` and `prev_secret_enc`, `identity_keys.private_enc`,
  `signing_keys.ciphertext`, `domains.smtp_sealed` and `smtp_pending_sealed`, `users.totp_sealed`,
  `users.recovery_codes_sealed` and `oauth_states.pkce_sealed`. The re-seal sweep of `pmail secrets rotate-master` covers every one of
  them. Recovery codes are sealed, not hashed under a `link` key, because link keys are deleted 7 days
  after a rotation and recovery codes live for months.
- **Who acted.** `audit_log.actor_key_id` names the API key and `actor_user_id` the person who acted in
  the console. Actions of the Worker itself (the Stripe webhook, crons) have neither. A quarantine
  release is not stored on the message, which goes back to `received`: its actor is in the
  `quarantine.release` audit row and in the `message.released` event (`released_by_key_id`, or
  `released_by_user_id` for a console release).
- **Console token hashes** (`invitations.token_hash`, `login_tokens.token_hash` and `code_hash`,
  `sessions.id_hash`, `oauth_states.state_hash` and `cookie_hash`) use the current `link` key and record
  its kid in `key_kid`. A lookup computes the HMAC under each `link` key still inside its verify window,
  newest first. A session used while its `key_kid` is not current is re-hashed under the current key in
  the same `UPDATE` that moves `last_seen_at`; a session idle past its 7-day rolling lifetime is expired
  anyway, so the 7-day verify window of an old link key loses no live session.
- **SES ingestion ledger.** `ses_ingest` makes mail received through SES arrive exactly once per S3
  object and recipient, whichever path (SNS push or SQS backstop) delivers the notification first. A row
  becomes `done` when the message is committed, `dropped` for an unknown recipient, `held` while the
  recipient's tenant is suspended (at most 5 days, then `dropped`), and `lost` when the S3 object vanished
  before ingestion (alert `ses_object_lost`). The every-minute backstop cron re-sends the pointers of rows
  still `queued` after 15 minutes and of `held` rows whose tenant is active again. The S3 object is
  deleted once no row for its key is still `queued` or `held`
  ([Domains on any DNS host § 4.5–4.6](domain-connections.md#45-inbound-through-ses)).
- **Write volume.** D1 receives about four writes per inbound message: the event index, and webhook
  delivery rows per endpoint (plus one `ses_ingest` row per recipient for mail received through SES). The
  per-message mailbox writes go to the Durable Object. Retention jobs prune `webhook_deliveries`,
  `event_index`, `idempotency_records` and `ses_ingest` after 30 days.
- **Console retention.** `oauth_states` rows expire 10 minutes after creation and are deleted 24 hours
  after expiry, as `login_tokens` are. Unconfirmed `waitlist` entries are deleted after 7 days, and
  confirmed ones 30 days after invitation (Cloud sign-up § 6.1). Erasure of a person deletes their
  `oauth_identities` and any `waitlist` row.

## 2. `IdentityMailbox` Durable Object (SQLite)

One object per identity. Every write path runs inside `transaction_sync` (or the `workers-rs`
equivalent) so that the message, the index and the outbox commit together.

```sql
-- mailbox schema v1
PRAGMA foreign_keys = ON;

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
-- keys: schema_version, tenant_id, identity_id, created_at, erased ('0'|'1'),
--       event_seq, fts_analyzer_version, embed_model, parser_version, size_bytes,
--       claim:{msg}     transport claim {token, claimed_at} (Outbound › The outbound consumer)
--       backoff:{msg}   quota/rate back-off {n, first_at} while the message stays queued
--       dispatch:{msg}  time the send pointer was (re)queued; read by the dispatch alarm
--       wait:{domain}   time of the latest active wait for that sender domain (Inbound › E5)
--       alarm:{purpose} pending wake-ups: outbox, lock, claim, dispatch, reconcile, maintenance (Design § 4)

CREATE TABLE threads (
  seq                INTEGER PRIMARY KEY,                  -- per mailbox; used in thread tokens
  id                 TEXT NOT NULL UNIQUE,                 -- thr_
  subject            TEXT NOT NULL,                        -- normalised subject of the first message
  first_at           INTEGER NOT NULL,
  last_at            INTEGER NOT NULL,
  last_inbound_at    INTEGER,
  last_outbound_at   INTEGER,
  message_count      INTEGER NOT NULL DEFAULT 0,
  unread_count       INTEGER NOT NULL DEFAULT 0,
  participants_json  TEXT NOT NULL DEFAULT '[]',           -- [{address,name}], capped at 50
  reply_from_address TEXT,                                 -- address the counterparty last wrote to
  fallback_pinned    INTEGER NOT NULL DEFAULT 0,           -- stays on platform address until quiet
  hold_json          TEXT,                                 -- legal hold {reason, until, set_by, set_at}
  lock_owner         TEXT,                                 -- send lock (FR-OUT-9)
  lock_until         INTEGER,
  archived           INTEGER NOT NULL DEFAULT 0,
  category           TEXT,                                 -- from the latest triaged inbound message
  needs_reply        REAL,
  urgency            INTEGER
);
CREATE INDEX threads_last ON threads(last_at DESC);

CREATE TABLE messages (
  rowid               INTEGER PRIMARY KEY,                 -- FTS rowid
  id                  TEXT NOT NULL UNIQUE,                -- msg_
  thread_seq          INTEGER NOT NULL REFERENCES threads(seq),
  direction           TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  status              TEXT NOT NULL CHECK (status IN (
                        'received','quarantined','throttled','hidden',                     -- inbound
                        'queued','submitted','delivered','deferred','bounced','complained',
                        'rejected','failed','uncertain','suppressed','canceled')),         -- outbound
  rfc_message_id      TEXT,                                -- normalised, without angle brackets
  message_id_synthetic INTEGER NOT NULL DEFAULT 0,         -- B3: hash-derived when missing
  provider            TEXT,                                -- cloudflare | ses | smtp | simulator | loopback
  provider_message_id TEXT,
  in_reply_to         TEXT,
  references_json     TEXT NOT NULL DEFAULT '[]',
  raw_sha256          TEXT,
  raw_r2_key          TEXT,
  raw_size            INTEGER,
  from_address        TEXT,
  from_name           TEXT,
  sender_domain       TEXT,                                -- organisational domain of From
  reply_to_json       TEXT NOT NULL DEFAULT '[]',
  to_json             TEXT NOT NULL DEFAULT '[]',
  cc_json             TEXT NOT NULL DEFAULT '[]',
  bcc_json            TEXT NOT NULL DEFAULT '[]',          -- outbound only
  delivered_to        TEXT,                                -- inbound envelope recipient
  is_bcc              INTEGER NOT NULL DEFAULT 0,          -- A10
  is_primary_recipient INTEGER NOT NULL DEFAULT 1,         -- A9: 1 on exactly one copy per tenant (Inbound)
  subject             TEXT,
  text                TEXT,                                -- full plain text (derived if HTML-only)
  html_sanitized      TEXT,
  extracted_text      TEXT,                                -- new content: quotes and signature removed
  snippet             TEXT,                                -- ≤ 240 chars of extracted_text
  sent_at             INTEGER,                             -- Date header, or submit time
  received_at         INTEGER NOT NULL,                    -- our clock
  kind                TEXT NOT NULL,                       -- inbound: normal|automated|dsn|list|calendar|mdn
                                                           -- outbound: transactional|marketing|auto_reply
  automated_json      TEXT,                                -- classification evidence
  auth_json           TEXT,                                -- spf, dkim[], dmarc, arc, authserv
  verdict             TEXT CHECK (verdict IN ('pass','fail','softfail','none','unaligned')),
  spam_score          REAL,
  known_sender        INTEGER,
  quarantine_reason   TEXT,                                -- auth_failed | spam | risky_attachment | blocked_sender | otp_unsolicited
  flags_json          TEXT NOT NULL DEFAULT '[]',          -- parse_degraded, message_id_conflict, encrypted,
                                                           -- hidden_text, sent_via_fallback, reprocessed, bcc,
                                                           -- thread_join_unverified, reconciled, loopback,
                                                           -- body_truncated, display_name_spoof,
                                                           -- lookalike_domain, reply_to_mismatch. The API
                                                           -- returns the trust ones (hidden_text, display_name_spoof,
                                                           -- lookalike_domain, reply_to_mismatch,
                                                           -- thread_join_unverified) in trust.flags, the rest in flags
  read                INTEGER NOT NULL DEFAULT 0,
  triage_status       TEXT CHECK (triage_status IN ('pending','done','skipped','failed')),
  triage_json         TEXT,
  idempotency_key_hash TEXT,                               -- outbound: hex SHA-256 of the Idempotency-Key
  operation           TEXT,                                -- send | reply | reply_all | forward
  parser_version      INTEGER,
  metadata_json       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX messages_thread   ON messages(thread_seq, received_at);
CREATE INDEX messages_rfcid    ON messages(rfc_message_id);
CREATE INDEX messages_provider ON messages(provider_message_id);
CREATE INDEX messages_hash     ON messages(raw_sha256);
CREATE INDEX messages_time     ON messages(received_at DESC);
CREATE INDEX messages_from     ON messages(from_address);
CREATE INDEX messages_status   ON messages(direction, status);

CREATE TABLE deliveries (                                  -- per-recipient outbound status
  message_rowid   INTEGER NOT NULL REFERENCES messages(rowid) ON DELETE CASCADE,
  address         TEXT NOT NULL,
  field           TEXT NOT NULL CHECK (field IN ('to','cc','bcc')),
  status          TEXT NOT NULL CHECK (status IN ('queued','suppressed','submitted','delivered','deferred',
                                                  'bounced','complained','rejected','failed','uncertain')),
  smtp_code       TEXT,
  enhanced_code   TEXT,
  smtp_response   TEXT,                                    -- trimmed to 512 chars
  bounce_type     TEXT CHECK (bounce_type IN ('hard','soft')),
  provider_event_ids_json TEXT NOT NULL DEFAULT '[]',      -- dedupe of provider events
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (message_rowid, address)
);

CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,                          -- att_
  message_rowid INTEGER NOT NULL REFERENCES messages(rowid) ON DELETE CASCADE,
  filename      TEXT,                                      -- sanitised: no path, ≤ 255 bytes
  content_type  TEXT NOT NULL,                             -- as declared
  sniffed_type  TEXT,                                      -- from magic bytes; wins on conflict (B10)
  size          INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  disposition   TEXT CHECK (disposition IN ('attachment','inline')),
  content_id    TEXT,
  r2_key        TEXT NOT NULL,
  text_status   TEXT NOT NULL CHECK (text_status IN ('pending','ready','unavailable','skipped')),
  text_r2_key   TEXT,
  text_pages    INTEGER,
  risk          TEXT CHECK (risk IN ('executable','macro','encrypted_archive','archive_bomb',
                                     'type_mismatch','encrypted_document')),
  scan_status   TEXT NOT NULL DEFAULT 'skipped' CHECK (scan_status IN ('skipped','pending','clean','infected','error'))
);
CREATE INDEX attachments_message ON attachments(message_rowid);

CREATE TABLE labels (
  message_rowid INTEGER NOT NULL REFERENCES messages(rowid) ON DELETE CASCADE,
  label         TEXT NOT NULL,                             -- ^[a-z0-9][a-z0-9_:-]{0,63}$
  PRIMARY KEY (message_rowid, label)
);
CREATE INDEX labels_label ON labels(label);

-- Keyword index. Contentless (text lives in messages); snippets are built in Rust.
CREATE VIRTUAL TABLE fts USING fts5(
  subject, participants, body_new, body_full, attachments, refs,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2'
);
-- Fuzzy fallback over short fields only (bounded size).
CREATE VIRTUAL TABLE fts_tri USING fts5(
  subject, participants, refs,
  content = '', contentless_delete = 1,
  tokenize = 'trigram'
);

CREATE TABLE refs (
  message_rowid INTEGER NOT NULL REFERENCES messages(rowid) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                             -- uk_plate, pcn, invoice, order, amount, phone,
                                                           -- email, domain, date, custom:<name> (custom:booking)
  value         TEXT NOT NULL,                             -- normalised: AB12CDE, +447700900123, GBP:412.80
  source        TEXT NOT NULL,                             -- subject | body | att:<att_id>:<page>
  PRIMARY KEY (message_rowid, kind, value, source)
);
CREATE INDEX refs_kind_value ON refs(kind, value);
CREATE INDEX refs_value      ON refs(value);

CREATE TABLE contacts (
  address         TEXT PRIMARY KEY,
  name            TEXT,
  domain          TEXT NOT NULL,
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  inbound_count   INTEGER NOT NULL DEFAULT 0,
  outbound_count  INTEGER NOT NULL DEFAULT 0,
  last_thread_seq INTEGER
);
CREATE INDEX contacts_domain ON contacts(domain);

CREATE TABLE idempotency (
  key_hash      TEXT PRIMARY KEY,                          -- hex SHA-256 of the Idempotency-Key header
  fingerprint   TEXT NOT NULL,                             -- sha256(operation, target, canonical body)
  operation     TEXT NOT NULL,
  message_id    TEXT,
  response_json TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL                           -- created_at + 30 days
);

CREATE TABLE outbox (                                      -- transactional event outbox
  seq          INTEGER PRIMARY KEY,                        -- per-identity event sequence
  event_id     TEXT NOT NULL UNIQUE,                       -- evt_
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,                              -- full event envelope
  occurred_at  INTEGER NOT NULL,
  dispatched_at INTEGER                                    -- set once queued to pm-webhooks
);
CREATE INDEX outbox_pending ON outbox(dispatched_at) WHERE dispatched_at IS NULL;

CREATE TABLE chunks (                                      -- semantic index bookkeeping
  vector_id     TEXT PRIMARY KEY,                          -- {msg_id}:{n} or {msg_id}:a{k}:{n} (≤ 64 bytes)
  message_rowid INTEGER NOT NULL REFERENCES messages(rowid) ON DELETE CASCADE,
  attachment_id TEXT,
  ordinal       INTEGER NOT NULL,
  page          INTEGER,
  char_start    INTEGER NOT NULL,
  char_end      INTEGER NOT NULL,
  model         TEXT NOT NULL,                             -- e.g. bge-m3@1
  status        TEXT NOT NULL CHECK (status IN ('pending','embedded','failed','deleting')),
  updated_at    INTEGER NOT NULL
);
CREATE INDEX chunks_status ON chunks(status);

CREATE TABLE verifications (                               -- codes and links for wait / sign-ups
  message_rowid INTEGER NOT NULL REFERENCES messages(rowid) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('code','link')),
  value         TEXT NOT NULL,
  sender_domain TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,                          -- received + 24 h; purged after
  consumed_at   INTEGER
);

CREATE TABLE rate_windows (                                -- inbound per-sender throttle (D5)
  sender      TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count       INTEGER NOT NULL,
  PRIMARY KEY (sender, window_start)
);
```

### Mailbox notes

- **Erasure** deletes the message row (cascading to deliveries, attachments, labels, refs, chunks and
  verifications). It also deletes the FTS rows (`DELETE FROM fts WHERE rowid = ?`), and the R2 objects
  and vectors listed before the delete. An identity-scope erasure ends with `delete_all()` on the
  object. See [Privacy and erasure](privacy.md).
- **Size watch.** The mailbox reports `pragma page_count * page_size` in `meta`. An alert fires at 70%
  of 10 GB. Raw MIME and attachments are in R2, so mailboxes grow slowly.
- **Fallback if `contentless_delete` is unavailable:** use an external-content table
  (`content='fts_docs'`) backed by a `fts_docs` table holding the same six columns. This is decided by
  spike S3 in the [build plan](../build-plan.md).

## 3. Other Durable Objects

```sql
-- DomainMonitor
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
-- domain_id, tenant_id, state, consecutive_pass, consecutive_fail, failing_since,
-- next_check_at, reminders_sent_json, last_ns_json, last_rdap_fingerprint,
--   probe:{token}    pending alignment probe {probe_id, sent_at}; dropped after 15 minutes (smtp_probe_timeout)
--   forward:{token}  pending forwarding test {address_id, sent_at}; dropped after 10 minutes (forwarding = failed)
-- Probe and forwarding-test tokens live only here, never in D1; the result is written to
-- domains.probe_last_at / probe_last_json or addresses.forwarding / forwarding_checked_at.
CREATE TABLE checks (
  id           INTEGER PRIMARY KEY,
  at           INTEGER NOT NULL,
  resolver     TEXT NOT NULL,                              -- cloudflare-doh | google-doh
  results_json TEXT NOT NULL,                              -- [{record, expected, observed, ok}]
  outcome      TEXT NOT NULL CHECK (outcome IN ('pass','degraded','fail','ownership_changed','error'))
);                                                         -- keeps the last 500 rows
CREATE TABLE outbox (seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
                     payload_json TEXT NOT NULL, occurred_at INTEGER NOT NULL, dispatched_at INTEGER);

-- JobRunner
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);   -- job_id, kind, tenant_id, status, attempt
CREATE TABLE steps (
  name        TEXT PRIMARY KEY,                            -- e.g. list_r2, delete_vectors, wipe_mailbox
  status      TEXT NOT NULL CHECK (status IN ('pending','running','done','failed','skipped')),
  cursor      TEXT,                                        -- resume point
  counts_json TEXT NOT NULL DEFAULT '{}',
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE outbox (seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
                     payload_json TEXT NOT NULL, occurred_at INTEGER NOT NULL, dispatched_at INTEGER);

-- TenantQuota (no meta table: its owner is kept under the storage key 'tenant_id' of the
-- object's key-value API and checked on every request, Security § 5.2)
CREATE TABLE counters (
  metric TEXT NOT NULL,                                    -- sends, sends:idn_..., agentic, ai_neurons
  window TEXT NOT NULL,                                    -- YYYY-MM-DD (tenant timezone) or minute bucket
  value  INTEGER NOT NULL,
  PRIMARY KEY (metric, window)
);
CREATE TABLE allowances (                                  -- plan + top-ups for the current period
  feature    TEXT PRIMARY KEY CHECK (feature IN ('inboxes','sends','triage','custom_domains','storage_gb','seats')),
  granted    INTEGER,                                      -- NULL = unlimited (exempt / disabled)
  used       INTEGER NOT NULL DEFAULT 0,                   -- consumed this period (or current count)
  held       INTEGER NOT NULL DEFAULT 0,                   -- units in open holds
  resets_at  INTEGER                                       -- NULL for counts that never reset
);
CREATE TABLE holds (
  id         TEXT PRIMARY KEY,                             -- hld_
  feature    TEXT NOT NULL,
  units      INTEGER NOT NULL,
  ref        TEXT NOT NULL,                                -- e.g. msg_… or idn_…; one open hold per (feature, ref)
  expires_at INTEGER NOT NULL,                             -- created or last extended + 10 minutes; the alarm releases it
  UNIQUE (feature, ref)
);
CREATE TABLE outcomes (                                    -- sliding windows for abuse thresholds
  identity_id TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('delivered','bounced','complained','other')),
  at          INTEGER NOT NULL,
  PRIMARY KEY (identity_id, seq)
);                                                         -- keeps the last 1,000 per identity
```

## 4. R2 objects

| Key | Content | Custom metadata | Deleted by |
|---|---|---|---|
| `inbound-staging/{yyyy}/{mm}/{dd}/{ulid}.eml` | Raw message before routing resolves | `envelope_to_hash` | The inbound consumer after the move, or the lifecycle rule (1 day) |
| `t/{ten}/i/{idn}/m/{msg}/raw.eml` | Raw inbound MIME | `tenant`, `identity`, `message` | Retention (`raw_days`), erasure |
| `t/{ten}/i/{idn}/m/{msg}/a/{att}` | Attachment bytes | same, plus `sha256` | Erasure, message retention |
| `t/{ten}/i/{idn}/m/{msg}/a/{att}.md` | Extracted text (Markdown, with page markers) | same | as above |
| `t/{ten}/i/{idn}/out/{msg}.eml` | Composed outbound MIME (sent copy) | same, plus `idem_key_sha256` (hex SHA-256 of the Idempotency-Key), `fingerprint` and `operation` | Retention, erasure |
| `t/{ten}/i/{idn}/out/{msg}/a/{att}` | Outbound attachment bytes (linked attachments, and copies for `GET …/attachments/{id}`) | `tenant`, `identity`, `message`, `sha256` | Retention, erasure |
| `t/{ten}/exports/{exp}.zip` | Subject-access export | `tenant`, `export` | 7 days after creation |

`email()` writes straight to the final key when routing resolved (the normal case). The staging prefix
is used only when the directory lookup fails transiently and the message is accepted for later routing.

The metadata on `out/{msg}.eml` lets a point-in-time restore of a mailbox rebuild the idempotency
ledger for sends made after the restore point ([Observability › Restore from PITR](observability.md#restore-from-pitr)).

**Optional backup bucket.** When `PM_BACKUP_BUCKET` is set, the nightly `backup` job copies every `t/`
object created since its last run to the same key in that bucket (binding `BACKUP`, same jurisdiction).
Retention and erasure delete each key from both buckets. See [Privacy › R2 backup copy](privacy.md#54-optional-r2-backup-copy).

## 5. Vectorize

```text
index:       pm-mail-chunks           (one per deployment; staging has its own)
dimensions:  1024                      (@cf/baai/bge-m3)
metric:      cosine
namespace:   tenant id (ten_…, ≤ 64 bytes)
vector id:   {message_id}:{n}  or  {message_id}:a{k}:{n}   (≤ 64 bytes)
metadata indexes (8 of 10 allowed):
  identity_id     string
  thread_id       string
  sent_at         number   (unix seconds)
  sender_domain   string
  direction       string   (inbound | outbound)
  has_attachment  boolean
  verdict         string
  kind            string   (body | attachment)
metadata stored: the indexed fields only. Never text, subject or addresses.
```

Create it with `pmail setup`, which calls the Vectorize API for the index and each metadata index.
Query with `topK ≤ 100` and `returnMetadata: "none"`: the message ID is parsed from the vector ID, and
text is always read back from the mailbox, which also enforces visibility (quarantine, holds, erasure).
