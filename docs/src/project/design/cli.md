# CLI and setup

Binding design for `pmail`, the command-line client: configuration, output and exit codes, `setup`,
`setup ses`, `deploy`, `upgrade`, `doctor`, `destroy`, secret and signing-key rotation, dead-letter
handling and the client-side behaviour of the mail and admin commands. It implements FR-CLI-1, FR-OPS-1
to FR-OPS-3, FR-CON-7 and FR-BILL-12, build plan milestone M16, the CLI half of M17 (`dlq`, and `secrets rotate-master` in M17 Foundation), the
`deploy --version` acceptance of M19, the CLI parts of FR-DOM-7 to FR-DOM-12 (M23: `domains add
--method`, `domains update`, `domains probe`, `addresses test-forwarding`, `setup ses`), of FR-CON-8
(M24: `waitlist invite`) and of FR-IDN-6 to FR-IDN-8 (M25: `identity-keys`, `assertions`, `http-sign`,
`keys rotate web_bot_auth`, [Agent signing keys](agent-keys.md#7-api-mcp-and-cli)), and the edge-case
rows H5, J8, J9 and N30 in the [edge-case register](../edge-cases.md).

Every command, flag and example is listed in the [CLI reference](../../reference/cli.md); this page
decides how they behave.

| | |
|---|---|
| Code | `crates/cli/` (package `pylota-mail-cli`, binary `pmail`) |
| Depends on | `pylota-mail` (SDK), `pylota-mail-api-types`, `pylota-mail-core` (address validation, key format, DNS record parsing), `clap =4.6.7`, `reqwest =0.13.5`, `serde =1.0.229`, `serde_json =1.0.151`, `sha2 =0.11.0`, `hmac =0.13.0`, `base64 =0.23.1`, `ulid =3.0.0`; and, each pinned at build time: `tokio` (current-thread runtime that `reqwest` needs, CLI binary only), `toml`, `flate2`, `tar`, `minisign-verify`, `getrandom`, and the AWS credential loader used by `setup ses` ([§2.6](#26-aws-credentials)) |
| Never depends on | `pylota-mail-worker`, `pylota-mail-platform`, `worker` ([Rust workspace §2](rust-workspace.md#2-crate-responsibilities-and-allowed-dependencies)) |
| Related designs | [Rust workspace §8](rust-workspace.md#8-generated-wranglertoml) (the generated `wrangler.toml`), [Identities, addresses and domains](identity-domains.md) (platform domain onboarding), [Observability §7.2](observability.md#72-pmail-doctor) (doctor checks) and [§8.3](observability.md#83-listing-and-redriving) (`dlq`), [Security §6](security.md#62-rotation-procedures) (secrets and signing keys), [Search §7](search.md#7-index-lifecycle) (index generations), [Domains on any DNS host](domain-connections.md) (connection methods, `setup ses`), [Cloud sign-up §6.1](cloud-signup.md#61-before-launch-the-waitlist) (`waitlist invite`) |
| External facts verified on 2026-10-09 | Cloudflare API reference pages for zones (list), DNS records (list), D1 (create, query), R2 (create bucket with `cf-r2-jurisdiction`, lifecycle `PUT` replaces the rule set), Queues (create, list), event subscriptions (create, list), Vectorize (index create, metadata index create and list), Email Routing (settings, `POST …/email/routing/dns`, catch-all `PUT`), Email Sending (subdomain create, update, DNS), Workers secrets; Wrangler 4 command reference for `deploy`, `secret put`, `secret bulk`, `versions upload`, `versions deploy`, `delete` and `queues subscription create` (flags `--source email.sending --zone-id --domain`); Cloudflare docs on version overrides (`Cloudflare-Workers-Version-Overrides`), gradual deployments with Durable Objects, deployment management (a Durable Object class change cannot be uploaded with `versions upload`), D1 migrations and D1 jurisdictions, Durable Object delete migrations, Email Sending event subscriptions (scoped to a zone apex or a verified sending subdomain), Email Service domain records; GitHub REST "Get a release by tag name" (`X-GitHub-Api-Version: 2026-03-10`); crates.io metadata of `minisign-verify`. The AWS facts behind `setup ses` (receiving regions, `GetAccount`, SNS `SignatureVersion`, SES quotas and pricing) are cited, read 2026-10-09, in [Domains on any DNS host §4.2](domain-connections.md#42-deployment-set-up-for-ses); AWS operation and field names not cited there are marked "verify at build time" |

## 1. Crate layout

```text
crates/cli/src/
  main.rs              clap definitions, global flags, runtime start, exit-code mapping
  config.rs            config file, profiles, precedence, key sources, file permissions
  output.rs            human and JSON renderers, tables, terminal sanitising, error printing
  resolve.rs           --identity, --tenant, --domain, --webhook arguments to IDs
  http.rs              SDK client construction, retries, idempotency keys, user agent
  sse.rs               server-sent events reader (ask)
  cloudflare/
    mod.rs             client: base URL, auth, envelope decoding, pagination, retries
    zones.rs dns.rs d1.rs r2.rs queues.rs vectorize.rs email_routing.rs email_sending.rs
    event_subscriptions.rs workers.rs ai.rs analytics.rs
  aws/
    mod.rs             credentials (§2.6), SigV4 signing with sha2 and hmac, error decoding, retries
    ses.rs s3.rs sns.rs sqs.rs iam.rs   the calls `setup ses` and the doctor's `ses` check make
  wrangler.rs          Node.js check, `npx --yes wrangler@4.139.0 …`, stdin piping, output capture
  bundle/
    release.rs         GitHub release lookup and streaming download
    verify.rs          minisign signature, SHA256SUMS parsing, SHA-256 checks
    extract.rs         safe tar.gz extraction
    render.rs          wrangler.toml.tmpl rendering and merging
    migrate.rs         D1 migration runner (D1 query API, schema_migrations)
  commands/
    setup.rs setup_ses.rs deploy.rs upgrade.rs doctor.rs destroy.rs login.rs config.rs secrets.rs
    dlq.rs jobs.rs waitlist.rs tenants.rs identities.rs addresses.rs domains.rs mail.rs threads.rs
    messages.rs search.rs ask.rs triage.rs wait.rs quarantine.rs webhooks.rs keys.rs suppressions.rs
    lists.rs erasure.rs export.rs members.rs billing.rs usage.rs audit.rs mcp.rs
    identity_keys.rs assertions.rs http_sign.rs
```

`main.rs` builds a `#[tokio::main(flavor = "current_thread")]` runtime. Commands are `async fn
run(ctx: &Ctx, args: …) -> Result<Output, CliError>`; `main` renders the `Output` or the error and maps
the error to an exit code ([§3.4](#34-exit-codes)). No command calls `std::process::exit` itself.

```rust
pub struct Ctx {
    pub profile: ResolvedProfile,      // url, key (may be absent for setup/deploy/doctor)
    pub mode: OutputMode,              // Human | Json | Quiet
    pub interactive: bool,             // stdin and stderr are terminals, and neither --json nor --yes
    pub cf: Option<CloudflareCreds>,   // token and account ID, when the command needs them
}

pub enum CliError {
    Usage(String),                                     // exit 2
    Config(String),                                    // exit 3
    Api { status: u16, envelope: Option<ErrorEnvelope> }, // exit by status, §3.4
    Network(String),                                   // exit 9
    Cloudflare { step: &'static str, status: Option<u16>, errors: Vec<CfError> }, // exit 10
    Prerequisite(String),                              // exit 10
    Verification(String),                              // exit 11
    DoctorFailed(u32),                                 // exit 12
    Timeout(String),                                   // exit 13
    Aws { step: &'static str, status: Option<u16>, code: Option<String> }, // exit 14
    Interrupted,                                       // exit 130
    Internal(String),                                  // exit 1
}
```

## 2. Configuration and credentials

### 2.1 The config file

The file is `~/.config/pylota-mail/config.toml` ([Configuration › CLI configuration](../../reference/configuration.md#cli-configuration)).
`$XDG_CONFIG_HOME/pylota-mail/config.toml` is used when `XDG_CONFIG_HOME` is set; on Windows the
file is `%APPDATA%\pylota-mail\config.toml`.

```rust
pub struct ConfigFile {
    pub default_profile: Option<String>,
    pub profiles: BTreeMap<String, Profile>,           // name: ^[a-z0-9][a-z0-9_-]{0,31}$
}
pub struct Profile {
    pub url: Option<String>,                           // https://mail.example.com (no path)
    pub key: Option<String>,                           // pmk_live_… / pmk_test_…
    pub key_env: Option<String>,                       // name of an environment variable
    pub key_command: Option<String>,                   // run through the shell; stdout is the key
    pub identity: Option<String>,                      // default --identity for mail commands
    pub tenant: Option<String>,                        // default --tenant for platform keys
    pub account_id: Option<String>,                    // Cloudflare account ID; written by setup
}
```

- Unknown keys are an error (`deny_unknown_fields`), so a typo never silently drops a setting.
- At most one of `key`, `key_env` and `key_command` may be set in a profile (exit 3 otherwise).
- **Permissions (Unix).** The file and its directory are created with modes `0600` and `0700`. Before
  reading, `pmail` checks `st_mode & 0o077 == 0` and that the owner is the current user; otherwise it
  refuses with exit 3 and the fix `chmod 600 <path>`. Writes go to a temporary file in the same
  directory (mode `0600`), then `rename`, so a crash never leaves a half-written file. On Windows the
  file is created in the user's profile directory, which only the user can read by default; no mode
  check is made.
- The Cloudflare API token is never stored in this file. `pmail` refuses to write a key named like
  `CLOUDFLARE_*` into it. The account ID is not a secret: `setup` stores it in the profile as
  `account_id` ([§2.5](#25-cloudflare-credentials)).

### 2.2 Precedence

Highest first, per setting:

| Setting | 1. Flag | 2. Environment | 3. Profile |
|---|---|---|---|
| Profile name | `--profile` | `PYLOTA_MAIL_PROFILE` | `default_profile`, else a profile named `default` |
| API URL | `--url` | `PYLOTA_MAIL_URL` | `url` |
| API key | `--key` | `PYLOTA_MAIL_KEY` | `key`, `key_env` or `key_command` |
| Default identity | `--identity` | – | `identity` |
| Default tenant | `--tenant` | – | `tenant` |
| Cloudflare account ID | `--account-id` | `CLOUDFLARE_ACCOUNT_ID` | `account_id`, else `PM_CF_ACCOUNT_ID` in the rendered `<dir>/wrangler.toml` |

- A missing profile named by `--profile` or `PYLOTA_MAIL_PROFILE` is exit 3. A missing default
  profile is not an error; the URL and key must then come from flags or the environment.
- **Which profile setup and login write.** `setup` and `login` store a key, so they write the profile
  named by `--profile`, default `default`; `PYLOTA_MAIL_PROFILE` and `default_profile` do not change it,
  so neither command can overwrite another environment's key by accident.
  (`keys create --save-profile <name>` names its profile explicitly; `config set` changes the profile
  it resolves.)
- The environment outranks the profile, so a `PYLOTA_MAIL_KEY` left in the environment keeps overriding
  a key saved in a profile. `login` prints a one-line warning to stderr when `PYLOTA_MAIL_KEY` is set and
  differs from the key it saved.
- `--key` on the command line is visible to other users through the process list on most systems.
  The CLI accepts it (scripts need it) but prints a one-line warning to stderr in human mode,
  suggesting `PYLOTA_MAIL_KEY` or a profile.
- The URL must be `https://` unless the host is `localhost`, `127.0.0.1` or `[::1]`. A trailing `/v1`
  or `/` is removed.
- The key must match `^pmk_(live|test)_[0-9a-hjkmnp-tv-z]{12}_[0-9a-hjkmnp-tv-z]{52}$`
  ([Security §4.1](security.md#41-key-format)) before it is sent anywhere; otherwise exit 3.

### 2.3 Key sources

- `key_env`: the variable must be set and non-empty, else exit 3 naming the variable.
- `key_command`: run once per invocation through `sh -c` (`cmd /C` on Windows) with stdin closed and a
  10-second timeout; stdout is trimmed of surrounding whitespace. A non-zero exit, a timeout or an
  output that fails the key pattern is exit 3. Its stderr is passed through. The command line is shown
  in errors; its output never is.

### 2.4 Resolving names to IDs

Commands accept names where people think in names. `resolve.rs` turns them into IDs before the main
request:

| Argument | Accepts | Resolution |
|---|---|---|
| `--identity` | `idn_…`, or an address | An ID is used as is. An address is resolved with `GET /v1/identities/lookup?address=…` (case-insensitive; an IDN domain is converted to its A-label first) |
| `--tenant` | `ten_…`, or a slug | An ID is used as is. A slug is resolved by paging `GET /v1/tenants` (platform keys) and matching `slug` exactly; a tenant key may only name its own tenant |
| `--domain` (domain commands) | `dom_…`, or a domain name | Names are resolved by listing the tenant's domains (and the platform domain) |
| webhook arguments | `whk_…` | IDs only |

When a mail command needs an identity and none is given, the profile's `identity` is used; an
identity key uses its own identity (from `GET /v1/me`); otherwise exit 2 with "Pass --identity".

When a tenant-scoped command needs a tenant and none is given: a tenant or identity key uses its own
tenant; a platform key uses the profile's `tenant`, else the **default tenant** (the one tenant with
an empty `address_suffix`, created by `setup`). This is why
`pmail identities create --username bookings --display-name "Acme Car Hire"` works with the platform
key that setup leaves in the profile. `GET /v1/me` is called at most once per invocation and cached for
that invocation only.

Three commands never fall back to the default tenant. `jobs start` needs `--tenant` and ignores the
profile's `tenant` ([§18](#18-other-client-side-behaviour)). `usage` and `usage daily` with a platform
key send `tenant_id` only from `--tenant` or the profile's `tenant`; without either the request carries
none, and the API answers `400 invalid_request` (exit 7), because a platform key must name the workspace
whose usage it reads.

### 2.5 Cloudflare credentials

The commands that call the Cloudflare API or Wrangler with the operator's own token are listed once, in
[CLI reference › Commands that use your Cloudflare token](../../reference/cli.md#commands-that-use-your-cloudflare-token).
They need:

- `CLOUDFLARE_API_TOKEN` (environment only; there is no flag, so it never appears in the process
  list). Missing: exit 3. It is never stored.
- The account ID: `--account-id` (a global flag, accepted by every command and used by those above),
  else `CLOUDFLARE_ACCOUNT_ID`, else the profile's `account_id`, which `setup` writes, else
  `PM_CF_ACCOUNT_ID` from the rendered `<dir>/wrangler.toml`. Missing: exit 3.

The CLI passes both to Wrangler through the child's environment, never as arguments. The permissions of
this token, and of the Worker's own `PM_CF_API_TOKEN`, are in one table:
[Deploy to Cloudflare › Create a Cloudflare API token](../../self-hosting.md#2-create-a-cloudflare-api-token).

The deployment directory is `./deploy` unless `--dir <path>` is given. It holds `wrangler.toml` and
`.bundle/<version>/` (extracted releases). `deploy/wrangler.toml` doubles as setup's record of the
resource IDs it created, so no other state file exists.

The platform operations (`dlq`, `keys rotate thread|link|cursor|web_bot_auth`, `jobs`,
`waitlist invite`) need no Cloudflare credentials: they are plain API calls with a platform key holding
`platform:ops` ([REST API › Platform operations](../../reference/api.md#platform-operations)). Neither do
`identity-keys`, `assertions create` and `http-sign`, which are plain API calls too, and
`assertions verify` and `webhooks verify` need no key at all.

### 2.6 AWS credentials

`setup ses` ([§6.9](#69-setup-ses)), `destroy --include-ses` ([§11](#11-destroy)) and the doctor's `ses`
check use the operator's local AWS
credentials, from the standard AWS sources: the environment variables `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`, then the profile named by `AWS_PROFILE` (else
`default`) in the shared files `~/.aws/credentials` and `~/.aws/config`. The exact resolution order and
which further sources are supported (IAM Identity Center sessions, `credential_process`): verify at
build time. There is no flag for a secret key, so none appears in the process list.

- No credentials found: exit 3 for `setup ses` and `destroy --include-ses`; the doctor's `ses` check is
  `skip`.
- These credentials are never written to the config file, never uploaded to the Worker and never
  printed. The Worker gets its own access key, for the IAM user that `setup ses` creates, through
  `wrangler secret put` on stdin.

## 3. Output

### 3.1 Modes

| Mode | Selected by | stdout | stderr |
|---|---|---|---|
| Human | default | Single objects as indented JSON; lists as aligned tables (columns per command, [§19](#19-command-to-endpoint-map)); progress commands as one line per step | Warnings, prompts, progress spinners (only when stderr is a terminal) |
| JSON | `--json` | Exactly one JSON document per invocation, followed by a newline. The one exception is `--stream` (`ask --json --stream`), which prints NDJSON: one JSON document per line as events arrive ([§17](#17-ask)) | Nothing, except a fatal error before any request could be made, which is also printed to stdout as an error document |
| Quiet | `--quiet` | Only the essential value: the new ID, the key or webhook secret, the search hit IDs, an assertion token, the signature headers of `http-sign`, or nothing | Errors only |

- In JSON mode the document is the API response body, unchanged (FR-CLI-1). List commands print
  `{ "data": [ … ], "next_cursor": … }`; with `--all` the CLI follows `next_cursor` (at most 10,000
  items unless `--limit` says otherwise) and prints one document with every item and
  `"next_cursor": null`.
- Commands that are not a single API call (`setup`, `setup ses`, `deploy`, `upgrade`, `doctor`,
  `destroy`, `secrets rotate-master`, `dlq redrive` over several items, `mcp config`, `webhooks verify`,
  `assertions verify`, `ask` without a stream) print the documents defined in their sections.
- `--json` turns off every prompt. A command that needs an answer it was not given fails with exit 2
  and says which flag to pass. `--yes` answers "yes" to confirmations except `destroy`'s typed
  confirmation ([§11](#11-destroy)).
- Colour is used only when stdout is a terminal and `NO_COLOR` is unset.

### 3.2 Untrusted text in a terminal

Subjects, display names, snippets, filenames, bodies, answers and quotes come from email and are
untrusted ([API reference](../../reference/api.md#message-object)). In human and quiet modes every such
string passes through `output::terminal_safe` before it is written:

- C0 controls except `\n` and `\t`, DEL, and C1 controls (U+0080–U+009F) are replaced with `\u{FFFD}`;
  this removes ANSI escape sequences, which could otherwise rewrite the screen or set the window title.
- Bidirectional controls (U+202A–U+202E, U+2066–U+2069) and zero-width characters (U+200B–U+200D,
  U+2060, U+FEFF) are shown as `<U+202E>`-style markers, so "Trojan Source" reordering is visible.
- In tables, newlines are shown as `⏎` and each cell is cut to its column width.

JSON mode prints strings exactly as the API returned them (JSON escaping makes them inert).

### 3.3 Errors

- Human mode prints to stderr:

  ```text
  error: idempotency_conflict (409): This Idempotency-Key was used with a different request body.
    fix: Use a new Idempotency-Key for a different message, or resend the original body.
    request_id: req_01J9Z4…
  ```

- JSON mode prints the [error envelope](../../reference/errors.md) to stdout. Errors raised by the CLI
  itself use the same shape with CLI codes (`cli_usage`, `cli_config`, `cli_prerequisite`,
  `cli_cloudflare`, `cli_aws`, `cli_verification`, `cli_doctor_failed`, `cli_timeout`,
  `cli_interrupted`, `cli_internal`), `retryable` set as for the matching exit code, and
  `request_id: null`.
- A `404` without the service's envelope is reported as `upstream_not_found`, exit 9, never as "not
  found": it came from a proxy or a wrong host ([Errors](../../reference/errors.md)).
- Cloudflare API failures print the step, the HTTP status and every `errors[].code` and `message`
  from the Cloudflare envelope, plus a fix from a table of known codes (missing permission, zone not
  found, resource name taken in another jurisdiction).
- AWS API failures (`setup ses`) print the step, the HTTP status and the AWS error code and message.
  Request signatures, credentials and the Worker's new access key are never printed.

### 3.4 Exit codes

| Code | Name | When |
|---|---|---|
| 0 | `ok` | Success. Also a `doctor` run with only `pass` and `warn` lines |
| 1 | `internal` | A bug in the CLI or an unexpected response shape |
| 2 | `usage` | Invalid flags or arguments; a required answer missing in non-interactive mode; `keys create --level platform` without `--permissions` |
| 3 | `config` | No URL or key; unreadable, invalid or insecure config file; failing `key_env`/`key_command`; missing `CLOUDFLARE_API_TOKEN` or account ID; no AWS credentials for `setup ses` or `destroy --include-ses`; `domains add` without `--local-token` answered `422 transport_unavailable` (the deployment, or the tenant's policy, lacks what the method needs: `details.reason` names it) or `422 cf_token_required` (the deployment has no `PM_CF_API_TOKEN`), [§18.1](#181-domains-add-without-pm_cf_api_token) |
| 4 | `auth` | API `401` or `403` (any code) |
| 5 | `not_found` | API `404` with a service error code |
| 6 | `conflict` | API `409`, `410` or `423` |
| 7 | `invalid` | API `400`, `413` or `422` |
| 8 | `limited` | API `402` (`billing_limit`) or `429` |
| 9 | `unavailable` | API `5xx`, a network or TLS failure, or a `404` without the service envelope |
| 10 | `cloudflare` | A Cloudflare API call or Wrangler run failed, or a prerequisite is missing (Node.js 22+, Wrangler) or not met (foreign MX records at the mail domain, `existing_mx`), during `setup`, `setup ses`, `deploy`, `upgrade`, `destroy`, `secrets`, `domains add --local-token` or `domains subscribe`. `doctor` never exits 10: a failed Cloudflare call is a failing check (exit 12) |
| 11 | `verification` | A release signature or checksum did not verify; `webhooks verify` found no valid signature; `assertions verify` found the assertion invalid |
| 12 | `doctor_failed` | `doctor` reported at least one `fail` |
| 13 | `timeout` | `wait` returned `timed_out: true`; a polling step (health, re-seal, erasure, SNS subscription confirmation) passed its deadline |
| 14 | `aws` | During `setup ses` or `destroy --include-ses`: an AWS API call failed (including access denied), or the AWS account is not ready (SES production access missing; the console steps are printed) |
| 130 | `interrupted` | SIGINT or Ctrl-C |

Exit codes are part of the CLI contract ([AGENTS.md](https://github.com/PILOTAAI/pylota-mail/blob/main/AGENTS.md):
"do not silently change a public contract"). New codes may be added; existing ones never change meaning.

## 4. HTTP behaviour against the API

- All API calls go through the SDK (`pylota_mail::Client`). The CLI sets
  `User-Agent: pmail/<version> (+https://github.com/PILOTAAI/pylota-mail)`.
- Timeouts: connect 10 s; request 30 s; `wait` uses `timeout + 15` s; `ask` and streaming have no
  overall timeout but abort after 30 s without a byte (the server sends a keep-alive every 10 s).
- **Idempotency keys.** Mail sends (`send`, `reply`, `reply-all`, `forward`) take
  `--idempotency-key`. When it is omitted, the CLI generates `pmail-<ulid>` and prints it to stderr in
  human mode (and includes it in a CLI-generated error document in JSON mode), so a person can rerun
  the command with the same key after a network error. Every other `POST` gets a generated key per
  invocation, so the CLI's own retries are safe. The exceptions are `assertions create` and
  `http-sign`: their endpoints ignore the header and never record it, because each call mints a new
  value and stores nothing, so the CLI sends none and a retry simply mints again.
- **Retries.** A request is retried at most 3 times when the error is retryable by
  [Errors › How a client should retry](../../reference/errors.md#how-a-client-should-retry): network
  errors and `5xx` with backoff 0.5 s, 1 s, 2 s plus up to 250 ms jitter; `429 rate_limited` after
  `Retry-After` (at most 60 s; longer waits are reported, not slept). Retries reuse the same
  idempotency key. `409 request_in_progress` is retried after 1 s, at most 5 times.
- Cursors are passed through; `--all` stops on `410 cursor_expired` with exit 6 and the items so far
  are not printed (a partial list would be mistaken for a complete one).

## 5. The Cloudflare client

`cloudflare::Client` talks to `https://api.cloudflare.com/client/v4` with
`Authorization: Bearer $CLOUDFLARE_API_TOKEN`.

- Responses use Cloudflare's envelope `{ success, errors[], messages[], result, result_info }`. A
  non-2xx status or `success: false` becomes `CliError::Cloudflare` with the step name.
- List calls follow `result_info` pages (`page`, `per_page`) or `cursor` where the endpoint uses one.
- Retries: `429` (honouring `Retry-After`) and `5xx` up to 5 times with backoff 1, 2, 4, 8, 16 s.
  `4xx` is never retried.
- **Find, then create.** Every create is preceded by a lookup by name, and the create only runs when
  the lookup finds nothing. A create that fails because the name exists (a race with a parallel run)
  is followed by one more lookup. This is what makes `setup` safe to re-run (FR-OPS-1).
- Request and response bodies are never logged. `--verbose` logs method, path (with the account and
  zone IDs), status and duration to stderr.

## 6. `setup`

`pmail setup --account-id <account-id> --domain mail.example.com --mail-domain agents.example --jurisdiction eu`

### 6.1 Flags

| Flag | Default | Meaning |
|---|---|---|
| `--account-id` | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account (a global flag, [§2.5](#25-cloudflare-credentials)). Setup stores it in the profile as `account_id` |
| `--domain` | – (required) | The API host, `PM_API_HOST`. Served as a Workers Custom Domain. It serves the REST API (`/v1/*`, including signed links `/v1/links/*`), MCP (`/mcp`), `/openapi.json`, `/health`, `/.well-known/*`, the provider hooks (`/hooks/*`) and `/billing/stripe/webhook`; and the console (`/console/*`) too when `--console-host` is not given |
| `--console-host` | the API host | The console host, `PM_CONSOLE_HOST` ([Cloud sign-up §2](cloud-signup.md#2-hostnames)). When it differs from `--domain`, it is served as a second Custom Domain on the same Worker |
| `--mail-domain` | asked interactively; required with `--json` or `--yes` | The platform mail domain, `PM_PLATFORM_DOMAIN`. Must be a zone apex in the account |
| `--jurisdiction` | `eu` | `eu` or `default`, `PM_JURISDICTION`. Applied to D1, R2 and Durable Objects at creation |
| `--owner-email` | asked interactively; required unless `--no-console` | The first console owner of the default tenant (FR-CON-7) |
| `--owner-name` | – | The owner's display name |
| `--tenant-name` | `Default` | Name of the default tenant |
| `--no-console` | off | Writes `PM_CONSOLE = "off"` into `[vars]` (FR-CON-7) |
| `--replace-mx` | off | Delete existing MX records at the mail domain that Email Routing does not use ([H5](../edge-cases.md)) |
| `--daily-send-quota` | unset | The account's Email Sending daily quota, copied from the dashboard, written as `PM_DAILY_SEND_QUOTA`. Without it the quota alert fires only on the first quota error, and `doctor` warns (`quota`) |
| `--backup-bucket` | unset | Name of a second R2 bucket, written as `PM_BACKUP_BUCKET`. Setup creates it in the same jurisdiction (step 3) and binds it as `BACKUP` ([Privacy §5.4](privacy.md#54-optional-r2-backup-copy)) |
| `--version` | the CLI's version | Release to deploy in step 13 |
| `--from-source` | off | Build the Worker locally for step 13 ([§8.8](#88---from-source)) |
| `--source-dir` | `.` | The repository checkout that `--from-source` builds |
| `--print-secrets` | off | Print generated secrets once, to stdout, at the end |
| `--rotate-pepper` | off | Break-glass: replace `PM_KEY_PEPPER`, which invalidates every API key ([§6.5](#65-the-bootstrap-key)) |
| `--profile` | `default` | Profile that receives the URL, the account ID and the bootstrap key. `default_profile` and `PYLOTA_MAIL_PROFILE` do not change it ([§2.2](#22-precedence)) |
| `--dir` | `./deploy` | Deployment directory |
| `--yes` | off | Accept confirmations (not `--replace-mx`'s, which must be given as a flag) |

Billing stays off: setup never writes `PM_BILLING`, so a self-hosted deployment needs no Stripe
account (FR-BILL-12), and the default tenant's billing mode is `disabled`. Sign-up stays closed: setup
writes `PM_SIGNUP = "closed"` (FR-CON-8), so people join a self-hosted deployment as the setup owner or
by invitation.

SES is not part of `setup`. A deployment that wants `dns_records`, `send_only` or the SES failover runs
`pmail setup ses` afterwards ([§6.9](#69-setup-ses)).

### 6.2 Preflight

All checks run before anything is created; each failure is exit 2, 3 or 10 with a fix.

1. `CLOUDFLARE_API_TOKEN` and the account ID are present ([§2.5](#25-cloudflare-credentials)).
2. `--domain` is a valid host name (A-label after IDNA conversion, no port, no path) and differs from
   `--mail-domain`; so is `--console-host` when given. `--mail-domain` is a valid domain.
   `--jurisdiction` is `eu` or `default`. `--daily-send-quota` is a positive integer. `--backup-bucket`
   is a valid R2 bucket name other than `pylota-mail-blobs`.
3. `node --version` reports 22 or later; then `npx --yes wrangler@4.139.0 --version` prints `4.139.0`
   (this also fills the npx cache, so later steps do not download).
4. The mail domain is a zone apex: `GET /zones?name={mail_domain}&account.id={account_id}` returns a
   zone whose `name` equals the mail domain. If it does not, the CLI repeats the call for each parent
   label to name the zone the domain belongs to, and fails with "agents.example is not a zone apex in
   this account (its zone is example)". Catch-all routing exists only on an apex
   ([Architecture §7](../architecture.md#7-deployment-topology)).
5. The API host's zone is found the same way (the longest parent that is a zone in the account), so
   Wrangler can attach the Custom Domain; and the console host's zone, when it differs.
6. **Existing mail ([H5](../edge-cases.md)).** `GET /zones/{zone_id}/dns_records?type=MX&name.exact={mail_domain}`.
   The expected Email Routing MX hosts are read from `GET /zones/{zone_id}/email/routing/dns`, never
   hard-coded. Any other MX record: without `--replace-mx`, stop with exit 10 (a prerequisite not met:
   the JSON error code is `cli_prerequisite` with `details.reason = "existing_mx"`), and the fix "This domain already receives mail elsewhere; use a dedicated domain, or pass --replace-mx to
   stop that mail". With `--replace-mx` (and a confirmation unless `--yes`), each foreign record is
   deleted with `DELETE /zones/{zone_id}/dns_records/{id}` in step 7.
7. Optional, warn-only: the four models in the template's `[vars]` are listed by
   `GET /accounts/{account_id}/ai/models/search?search={name}` (endpoint and parameter: verify at
   build time). A missing model is a warning, because a deployment can override it later.

### 6.3 Steps

Each step prints `created`, `exists`, `updated` or `skipped` with the resource and its ID. The
**Idempotency** column says how a re-run behaves.

| # | Step | Cloudflare call(s), in order | Idempotency |
|---|---|---|---|
| 1 | Download and verify the release bundle | GitHub release lookup and downloads ([§8.1](#81-bundle-download), [§8.2](#82-signature-and-checksums)) | An extracted, verified `.bundle/<version>/` is reused |
| 2 | D1 database `pylota-mail` | `GET /accounts/{a}/d1/database?name=pylota-mail` (filter parameter: verify at build time; otherwise list and match `name`); if absent `POST /accounts/{a}/d1/database` `{"name":"pylota-mail","jurisdiction":"eu"}` (no `jurisdiction` for `default`) | Found by name. If the existing database reports a different jurisdiction, stop: it cannot be moved ([Privacy](privacy.md#3-jurisdiction-and-residency)) |
| 3 | R2 bucket `pylota-mail-blobs`, and the backup bucket with `--backup-bucket` | `GET /accounts/{a}/r2/buckets/pylota-mail-blobs` with header `cf-r2-jurisdiction: eu`; if `404`, `POST /accounts/{a}/r2/buckets` `{"name":"pylota-mail-blobs"}` with the same header (jurisdiction is a header, not a body field). The same two calls for `{PM_BACKUP_BUCKET}` when it is set, in the same jurisdiction | Found by name in the jurisdiction. A bucket of the same name in another jurisdiction is reported, not reused |
| 4 | R2 lifecycle rule | `GET …/buckets/pylota-mail-blobs/lifecycle`, then `PUT …/lifecycle` with the existing rules plus `{"id":"pm-inbound-staging","enabled":true,"conditions":{"prefix":"inbound-staging/"},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":86400}}}` | `PUT` replaces the whole rule set, so the CLI merges: other rules are kept, a rule with id `pm-inbound-staging` is replaced. No `PUT` when it is already identical |
| 5 | Queues | `GET /accounts/{a}/queues` (all pages); for each missing name `POST /accounts/{a}/queues` `{"queue_name": …}`. Dead-letter queues first: `pm-inbound-dlq`, `pm-outbound-dlq`, `pm-delivery-events-dlq`, `pm-webhooks-dlq`, `pm-index-dlq`, then `pm-inbound`, `pm-outbound`, `pm-delivery-events`, `pm-webhooks`, `pm-index` | Found by name |
| 6 | Vectorize index `pm-mail-chunks` | `GET /accounts/{a}/vectorize/v2/indexes/pm-mail-chunks`; if absent `POST /accounts/{a}/vectorize/v2/indexes` `{"name":"pm-mail-chunks","description":"pylota-mail generation=1 embed_model=@cf/baai/bge-m3","config":{"dimensions":1024,"metric":"cosine"}}`. Then `GET …/metadata_index/list` and, for each missing, `POST …/metadata_index/create` `{"propertyName": …, "indexType": …}` for `identity_id` string, `thread_id` string, `sent_at` number, `sender_domain` string, `direction` string, `has_attachment` boolean, `verdict` string, `kind` string ([Data model](data-model.md)) | Found by name. An existing index with other dimensions or metric stops setup. Metadata indexes are created before any vector is written, because vectors written earlier are not filterable ([Search §7.3](search.md#73-re-embed-job-embedding-model-change)) |
| 7 | Email Routing on the mail domain | `GET /zones/{z}/email/routing`; if not enabled, delete foreign MX records when `--replace-mx` was accepted, then `POST /zones/{z}/email/routing/dns` `{"name": "{mail_domain}"}` (adds and locks the MX and SPF records); then `PATCH /zones/{z}/email/routing` `{"support_subaddress": true}` if it is not already `true` | Read first; each call only when the setting differs |
| 8 | Ownership record | `GET /zones/{z}/dns_records?type=TXT&name.exact=_pylota-mail.{mail_domain}`; if absent, `POST /zones/{z}/dns_records` `{"type":"TXT","name":"_pylota-mail.{mail_domain}","content":"pm-verify={token}","ttl":1}` ([Identities, addresses and domains](identity-domains.md), step 4) | An existing `pm-verify=` value is reused as the token |
| 9 | Email Sending on the mail domain | `GET /zones/{z}/email/sending/subdomains`; if no entry has `name == mail_domain`, `POST /zones/{z}/email/sending/subdomains` `{"name": "{mail_domain}"}`; then `PATCH /zones/{z}/email/sending/subdomains/{tag}` `{"drop_suppressed_recipients": false, "preview_enabled": false}` when either differs ([Outbound › G4](outbound.md#provider-suppressions-and-resending-g4), [Privacy](privacy.md#3-jurisdiction-and-residency)) | Found by name. Whether an apex is onboarded through this endpoint, and whether both fields are accepted by `PATCH`, are verified by spike S9; the fallback is the dashboard step printed by `doctor` |
| 10 | Rate-limit namespace IDs | No call when `deploy/wrangler.toml` already holds an ID for each of the six bindings (`RL_API`, `RL_SEARCH`, `RL_AGENTIC`, `RL_SEND`, `RL_SIGNIN`, `RL_SIGN`). Otherwise list the account's scripts (`GET /accounts/{a}/workers/scripts`) and read each script's bindings (`GET /accounts/{a}/workers/scripts/{name}/settings`; verify at build time), collect every `ratelimit` binding's `namespace_id`, and pick the smallest unused integers from 1001 for the bindings that have none | Kept across re-runs through the rendered file ([Rust workspace §8](rust-workspace.md#8-generated-wranglertoml)); a file from an older release that lacks `RL_SIGNIN` or `RL_SIGN` gets one new ID for each missing binding |
| 11 | Render `deploy/wrangler.toml` | none ([§7](#7-rendering-wranglertoml)) | Deterministic; a re-run with the same inputs writes the same bytes |
| 12 | D1 migrations | `POST /accounts/{a}/d1/database/{id}/query` per migration ([§8.5](#85-d1-migrations)) | `schema_migrations` records each applied version |
| 13 | First deploy | `npx --yes wrangler@4.139.0 deploy --config <dir>/wrangler.toml` from the bundle directory. Creates the Worker `pylota-mail`, its Durable Object classes, queue consumers, cron triggers and the Custom Domain (two when the console host differs) | Skipped when `/health` already reports this version and the rendered file is unchanged since the last deploy ([§8.9](#89-no-op-redeploys)) |
| 14 | Secrets | `GET /accounts/{a}/workers/scripts/pylota-mail/secrets` (names only); for each missing required secret, generate 32 bytes from the OS CSPRNG, base64, and pipe it to `npx --yes wrangler@4.139.0 secret put {NAME} --name pylota-mail` on stdin. `PM_KEY_PEPPER` follows [§6.5](#65-the-bootstrap-key), which decides here whether a new pepper is uploaded | Existing secrets are never overwritten or read (Worker secrets are write-only), except a pepper replaced by §6.5 |
| 15 | Health | `GET https://{api_host}/health` every 5 s until `200` with `version` equal to the bundle's `VERSION`, at most 5 minutes (the Custom Domain's certificate can take minutes) | Pure read. A timeout is exit 13; a re-run continues here |
| 16 | Event subscription | `GET /accounts/{a}/event_subscriptions/subscriptions` and look for `name = "pylota-mail {mail_domain}"`; if absent, `npx --yes wrangler@4.139.0 queues subscription create pm-delivery-events --source email.sending --events message.delivered,message.deferred,message.bounced,message.failed,message.rejected,message.complained --zone-id {z} --domain {mail_domain} --name "pylota-mail {mail_domain}"`, then list again to read its ID | Found by name. Wrangler's flags for the `email.sending` source are documented; the REST body for that source is not, so the CLI uses Wrangler here |
| 17 | Catch-all to the Worker | `GET /zones/{z}/email/routing/rules/catch_all`; unless it is enabled with exactly one `worker` action whose value is `["pylota-mail"]`, `PUT /zones/{z}/email/routing/rules/catch_all` `{"actions":[{"type":"worker","value":["pylota-mail"]}],"matchers":[{"type":"all"}],"enabled":true,"name":"pylota-mail"}` | Read first; `PUT` only on a difference |
| 18 | Read the records back | `GET /zones/{z}/email/routing/dns` and `GET /zones/{z}/email/sending/subdomains/{tag}/dns`; normalise to `{ type, name, value, priority, purpose, required }` and add the ownership TXT (FR-DOM-3) | Pure read |
| 19 | Bootstrap key | D1 query API ([§6.5](#65-the-bootstrap-key)) | Skipped when the profile already holds a working platform key |
| 20 | Platform domain row | D1 query API ([§6.6](#66-the-platform-domain-row)) | Upsert by `name` |
| 21 | Default tenant | `GET /v1/tenants` (bootstrap key) and look for `address_suffix == ""`; if absent `POST /v1/tenants` with `Idempotency-Key: pmail-setup-default-tenant` and `{"slug":"default","name":"{tenant_name}","address_suffix":"","owner":{"email":"{owner_email}","name":"{owner_name}"}}` (`owner` omitted with `--no-console` and no `--owner-email`) | Found by suffix. The owner receives a sign-in link from the Worker ([Console design](console.md)) |
| 22 | System identity | D1 query API: insert the `identities` row (`is_system = 1`, the default tenant, `username` and `display_name` from `PM_SYSTEM_FROM`, `owner_name = 'Operator'`, `owner_email` = `--owner-email` or `postmaster@{mail_domain}`, `send_policy_json = '{"daily_cap":50000}'`, `mailbox_do_id = ''`) and its `active` primary address on the platform domain, in one batch. The every-minute cron mints the mailbox and sends `Init` ([Identities, addresses and domains › The system identity](identity-domains.md#the-system-identity)) | Found by `is_system = 1`. A changed `PM_SYSTEM_FROM` inserts the new address as an `active` platform-domain alias in a D1 query API batch (setup's internal path: no reserved-name or role-name check, which the public `POST …/addresses` would apply to a name such as `noreply`), then promotes it through the API (bootstrap key); the old one retires as usual |
| 23 | Mail test and `PM_TRUSTED_AUTHSERV_ID` | Run the `--mail-test` check of `doctor` ([§10](#10-doctor)) with the bootstrap key. Write the observed `Authentication-Results` authserv-id to `PM_TRUSTED_AUTHSERV_ID` in `deploy/wrangler.toml` and deploy once more (a variable change only) | Skipped when the rendered file already holds the observed value. A failed mail test is a warning: setup finishes, `PM_TRUSTED_AUTHSERV_ID` stays empty, and SPF-only alignment is treated as `unverified` until a re-run sets it ([Inbound › Authentication verdict](inbound.md#authentication-verdict)) |
| 24 | Summary | `doctor` checks `dns.platform`, `routing.catch_all`, `sending.domains`, `sending.event_subscriptions`, `secrets`, `health` | Pure read |

### 6.4 Why this order

```text
 resources (2-10) ──► render (11) ──► D1 schema (12) ──► Worker (13) ──► secrets (14)
                                                                             │
   default tenant (21) ◄── bootstrap key (19, 20) ◄── catch-all (17) ◄── health (15, 16)
         │
         ▼
   system identity (22) ──► mail test, PM_TRUSTED_AUTHSERV_ID (23) ──► summary (24)
```

- **Resources before the render.** The rendered file needs the D1 ID and the rate-limit namespace IDs,
  and Wrangler refuses bindings to queues or indexes that do not exist.
- **Schema before code** (step 12 before 13). The Worker's first request, cron or queue batch reads
  D1; an empty database would fail them. This is the same rule `deploy` follows for every release
  ([§8.4](#84-order-of-a-deploy)).
- **Code before secrets** (13 before 14). `wrangler secret put` attaches a secret to an existing
  Worker, creating and deploying a new version each time. Until all required secrets exist, the Worker
  answers `503 unavailable` to everything ([Observability §7.1](observability.md#71-get-health)),
  which is harmless because no mail is routed to it yet.
- **Catch-all last among the Cloudflare steps** (17 after 13–15). Email Routing was enabled in step
  7, so MX records exist from then on, but without a catch-all every recipient is unknown and
  Cloudflare refuses the mail at SMTP time. A catch-all that pointed at a missing Worker, or at a
  Worker without secrets, would accept mail that then could not be stored. With this order, mail to
  the platform domain is refused until the Worker can store it durably, and accepted from the moment
  it can. Mail sent during setup is refused, never lost.
- **Keys, domain row and tenant after the catch-all**, because they need a working Worker: the
  tenant's `TenantQuota` object ID and the domain's `DomainMonitor` object ID can only be minted
  inside the Worker, and the owner's sign-in link is sent by it.
- **System identity after the default tenant** (22 after 21), because its row belongs to that tenant;
  the owner's sign-in link waits for it (the Worker retries the send until the system identity's
  mailbox exists, at most 2 minutes).
- **Mail test last** (23): it needs the catch-all, the system identity's domain and a key, and its
  result is the authserv-id that Cloudflare's MX stamps ([spike S2](index.md#spikes) records it first).

Setup therefore performs the first deploy itself. `pmail deploy` run straight after it finds nothing
to change and exits 0 ([§8.9](#89-no-op-redeploys)), so the documented sequence `setup`, `deploy`,
`keys create` works as written.

### 6.5 The bootstrap key

The first API key cannot be created through the API (there is no key to authenticate with), and the
Worker stores only `hex(HMAC-SHA256(PM_KEY_PEPPER, key))` ([Security §4.1](security.md#41-key-format)).
Setup is the only time the CLI knows the pepper, because it generated it. The bootstrap path:

1. If the current profile has a key and `GET /v1/me` returns `200` with `level: "platform"`, skip.
2. Read the state: is `PM_KEY_PEPPER` among the secret names (step 14), and
   `SELECT COUNT(*) AS n FROM api_keys` through the D1 query API.
3. Decide:

| `PM_KEY_PEPPER` | `api_keys` rows | Action |
|---|---|---|
| missing | any (normally 0) | Generate pepper `P` in memory, upload it in step 14, insert the key below |
| present | 0 | The old pepper protects nothing. Generate a new `P`, upload it with `wrangler secret put PM_KEY_PEPPER`, insert the key |
| present | > 0 | Stop with exit 3: "Keys exist; use `pmail login` with an existing platform key, or `pmail setup --rotate-pepper` (invalidates every key)" |
| present, with `--rotate-pepper` | > 0 | Typed confirmation of the platform domain, then as row 2. Every existing key stops working at once; this is the break-glass procedure in [Security §6.2](security.md#62-rotation-procedures) |

   **When.** The decision is taken in step 14, when the secret names are listed; the D1 migrations of
   step 12 have created `api_keys`, so it can be counted. Rows 1, 2 and 4 upload the new pepper there,
   with the other missing secrets, and `P` stays in memory until step 19 inserts the key. Row 3
   uploads nothing and stops setup in step 19, after the profile's key was tried (point 1). With
   `--rotate-pepper`, point 1 is not applied.

4. Generate the key natively with `core::keys` and the OS CSPRNG: `lookup` (12 characters, 60 random
   bits) and `secret` (52 characters, 32 random bytes), giving `pmk_live_{lookup}_{secret}`.
5. Insert it and an audit row in one D1 query request (two statements; see [§8.5](#85-d1-migrations)
   on atomicity):

```sql
INSERT INTO api_keys (id, lookup, hash, name, level, tenant_id, identity_id, mode,
                      permissions_json, created_by_key_id, expires_at, created_at)
VALUES (?1, ?2, ?3, 'setup-bootstrap', 'platform', NULL, NULL, 'live', ?4, NULL, ?5, ?6);

INSERT INTO audit_log (id, tenant_id, actor_key_id, action, target_type, target_id,
                       details_json, request_id, created_at)
VALUES (?7, NULL, NULL, 'key.create', 'api_key', ?1, '{"via":"pmail setup"}', NULL, ?6);
```

   - `?1` `key_` + ULID; `?3` lower-case hex of `HMAC-SHA256(P, whole key string)`; `?4` the JSON array
     of every permission a platform key may hold ([API reference](../../reference/api.md#permissions)):
     every permission except `identities:sign`, which platform keys cannot hold
     ([Agent signing keys §6](agent-keys.md#6-permissions-limits-and-plans)); `?5` `now + 24 h`
     in Unix milliseconds; `?6` now; `?7` `aud_` + ULID. The D1 query API takes parameters as strings;
     SQLite's integer affinity stores `?5` and `?6` as integers.
6. Save the URL (`https://{api_host}`) and the key in the profile ([§2.1](#21-the-config-file)), and
   drop `P` from memory.

The bootstrap key expires after 24 hours on purpose. `pmail keys create --level platform --name
first-key --permissions <list>` creates the long-lived key; a platform key needs an explicit
`--permissions` ([§18](#18-other-client-side-behaviour)), so setup's summary prints the whole command
with every permission a platform key may hold. When it runs interactively with a profile whose key is
named `setup-bootstrap`, it asks whether to store the new key in that profile and revoke the bootstrap
key (`DELETE /v1/keys/{id}`); `--save-profile <name>` stores it without asking, and the bootstrap key
then expires on its own.

### 6.6 The platform domain row

The `domains` row needs a `DomainMonitor` object ID (`monitor_do_id NOT NULL`, [Data model](data-model.md)),
which only the Worker can mint (jurisdiction-bound unique IDs). Setup writes everything it learned from
the Cloudflare API and leaves the monitor ID empty; the Worker completes the row:

```sql
INSERT INTO domains (id, tenant_id, name, kind, method, inbound, zone_id, is_apex, routing_mode,
                     transport, reply_token, receiving, sending, state, state_changed_at,
                     ownership_token, event_subscription_id, records_json, monitor_do_id,
                     created_at, updated_at)
VALUES (?1, NULL, ?2, 'platform', 'platform', 'routing', ?3, 1, 'catch_all',
        'cloudflare', 'subaddress', 1, 1, 'pending', ?4,
        ?5, ?6, ?7, '',
        ?4, ?4)
ON CONFLICT(name) DO UPDATE SET
  zone_id = excluded.zone_id, ownership_token = excluded.ownership_token,
  event_subscription_id = excluded.event_subscription_id,
  records_json = excluded.records_json, updated_at = excluded.updated_at;
```

**Requirement on the Worker** (owned by [Identities, addresses and domains](identity-domains.md#the-platform-domain)):
the `* * * * *` cron selects `SELECT id, kind FROM domains WHERE monitor_do_id = '' LIMIT 20`, mints a
`DomainMonitor` ID in `PM_JURISDICTION` for each, sets `monitor_do_id`, sends `DomainRequest::Init`,
and emits `domain.created` for rows with a `tenant_id`. The same hook serves domains that
`pmail domains add` onboarded with the local token ([§18.1](#181-domains-add-without-pm_cf_api_token)).
Setup polls `SELECT monitor_do_id FROM domains WHERE kind = 'platform'` for up to 2 minutes and reports
`monitor: started` or a warning naming the cron.

### 6.7 Re-runs and failures

- Every step can be repeated. A failed run stops at the failing step with its Cloudflare error and fix;
  running the same command again continues, because every earlier step finds its resource.
- Changing `--mail-domain`, `--domain` or `--jurisdiction` on a re-run against a deployed account is
  refused (exit 2): the platform domain is part of every address and the jurisdiction is fixed at
  creation. The values are read from the rendered file.
- Setup never deletes anything, except foreign MX records with `--replace-mx`.
- Interrupting setup (Ctrl-C) finishes the current HTTP request, writes nothing further and exits 130.

### 6.8 Output

Human mode prints one line per step and then:

```text
Pylota Mail 1.0.0 is running at https://mail.example.com
Platform domain: agents.example (Email Routing catch-all → pylota-mail, Email Sending onboarded)
Default tenant: ten_01JA… (addresses look like name@agents.example)
Console owner: sam@acmecarhire.example (sign-in link sent)
Profile "default" holds a bootstrap key that expires in 24 hours.
Next: pmail keys create --level platform --name first-key --permissions tenants:manage,platform:ops,…
      pmail doctor --mail-test
```

The real summary prints the `--permissions` list in full (every permission except `identities:sign`).

JSON mode prints `{ "version", "api_url", "platform_domain", "tenant_id", "steps": [ { "step",
"status", "resource", "id" } ], "secrets": { … } }`, where `secrets` is present only with
`--print-secrets`. Without `--print-secrets`, generated secrets are never written to stdout, a file or
a log.

### 6.9 `setup ses`

`pmail setup ses --region eu-west-2 [--allow-non-eu] [--prefix <prefix>] [--dir <path>] [--yes]`

Connects the deployment to Amazon SES once, for the `dns_records`, `send_only` and `smtp_relay`
(`inbound: ses`) methods and for the SES failover of [J5](../edge-cases.md). The resources and their
settings are owned by [Domains on any DNS host §4.2](domain-connections.md#42-deployment-set-up-for-ses);
this section decides the CLI's part. It runs after `setup`, against the deployment in `--dir`.

| Flag | Default | Meaning |
|---|---|---|
| `--region` | – (required) | The SES region, `PM_SES_REGION` |
| `--allow-non-eu` | off | Accept a region outside the EU and the UK when `PM_JURISDICTION = "eu"` ([N30](../edge-cases.md)) |
| `--prefix` | `pylota-mail-{aws-account-id}` | Prefix of the inbound S3 bucket, `{prefix}-inbound`. The default holds the AWS account ID, so two accounts never choose the same bucket name |
| `--dir` | `./deploy` | Deployment directory; its `wrangler.toml` must exist (setup ran) |
| `--yes` | off | Accept the IAM policy without the interactive review |

It uses the operator's local AWS credentials ([§2.6](#26-aws-credentials)), plus the Cloudflare
credentials of [§2.5](#25-cloudflare-credentials) for `wrangler secret put`, the deploy and the platform
identity's DNS records. Like `setup`, it is idempotent and reads before it writes: every step looks the
resource up first, and creates or updates it only when it is missing or differs. Each step prints
`created`, `exists`, `updated` or `skipped`.

**Checks before anything is created** (each stops the command):

1. `deploy/wrangler.toml` exists, and `GET https://{PM_API_HOST}/health` answers with the CLI's version
   (the Worker must confirm the SNS subscriptions later, and step 10 deploys). A different version stops
   with exit 2 and the fix `pmail upgrade`, so `setup ses` never changes the version as a side effect.
   `PM_JURISDICTION` and `PM_PLATFORM_DOMAIN` are read from the file.
2. **Region.** `--region` must be one of the regions that receive mail (the list on AWS's endpoints
   page, read 2026-10-09, compiled into the CLI); otherwise exit 2, because `dns_records` could not
   receive. With `PM_JURISDICTION = "eu"`, a region other than `eu-central-1`, `eu-west-1`, `eu-west-2`
   (London), `eu-south-1`, `eu-west-3` and `eu-north-1` is refused with exit 2 unless `--allow-non-eu` is
   given ([N30](../edge-cases.md)). For this check `eu` means "EU or UK": the UK has an EU adequacy
   decision under the GDPR (European Commission [adequacy decisions](https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/adequacy-decisions_en), renewed 19 December 2025, read
   2026-10-09), so London is an acceptable data location. It differs from Cloudflare's `eu` jurisdiction
   for D1, R2 and Durable Objects, which means the EU only.
3. **Account.** SES `GetAccount` in the region. Without production access, the command prints the AWS
   console steps to request it and stops with exit 14; nothing has been created. On the Essentials plan
   ($0.16 per 1,000 against $0.10 à la carte, SES pricing read 2026-10-09) it prints a warning and
   continues. How the plan is read from the account: verify at build time; if it cannot be read, the
   warning names both prices.

**Steps**, in order. The numbers in brackets are the rows of Domains on any DNS host §4.2.

| # | Step | Notes |
|---|---|---|
| 1 | S3 bucket `{prefix}-inbound` and its policy [3] | The bucket policy names the rule `pm-deliver`, so it is written before the rule that writes to the bucket |
| 2 | SNS topic `pylota-mail-inbound` [4] | `SetTopicAttributes` `SignatureVersion = 2` when the attribute differs (the default is 1) |
| 3 | SQS queue `pylota-mail-inbound` and its subscription to the topic [6] | The backstop |
| 4 | Receipt rule set and rule `pm-deliver` [7, 8] | An account that already has an active rule set keeps it: the rule is added to that set, and its name becomes `PM_SES_RULE_SET`. Otherwise the set `pylota-mail` is created and made active |
| 5 | Configuration set, event destination and the delivery-events topic [10] | As in [Outbound › Amazon SES](outbound.md#amazon-ses). This topic, `PM_SES_SNS_TOPIC_ARN`, also gets `SignatureVersion = 2` |
| 6 | Platform identity [9] | `CreateEmailIdentity` for the platform domain; its DKIM CNAMEs are written into the platform zone through the Cloudflare API (find, then create) |
| 7 | IAM user `pylota-mail-worker` and its policy [11] | The policy JSON is printed for review first. Interactive runs ask before applying it; non-interactive runs need `--yes`, else exit 2. An existing policy that differs is shown as a diff |
| 8 | The Worker's access key | Only when `PM_SES_ACCESS_KEY_ID` is not among the Worker's secret names (Worker secrets are write-only, so an existing key is never read or replaced). `CreateAccessKey`, then `PM_SES_ACCESS_KEY_ID` and `PM_SES_SECRET_ACCESS_KEY` are piped to `wrangler secret put` on stdin and dropped from memory. They are never written to disk or printed; `--print-secrets` does not exist here |
| 9 | Variables | Renders `deploy/wrangler.toml` ([§7](#7-rendering-wranglertoml)) with `PM_SES_REGION`, `PM_SES_INBOUND_BUCKET`, `PM_SES_INBOUND_TOPIC_ARN`, `PM_SES_INBOUND_QUEUE_URL`, `PM_SES_RULE_SET` and `PM_SES_SNS_TOPIC_ARN` under `[vars]`. These six are owned by `setup ses`: a re-run writes the values it found |
| 10 | Deploy | `pmail deploy` ([§8](#8-deploy)), so the Worker reads the new variables. A re-run that changed nothing is a no-op ([§8.9](#89-no-op-redeploys)) |
| 11 | HTTPS subscriptions [5] | `https://{PM_API_HOST}/hooks/ses/inbound` on the inbound topic and `https://{PM_API_HOST}/hooks/ses` on the delivery-events topic. They come after the deploy because the Worker confirms only a subscription for the topic it is configured with ([§4.5](domain-connections.md#45-inbound-through-ses)). The CLI waits up to 5 minutes for both to be confirmed (exit 13 after that; a re-run continues) |
| 12 | Summary | The doctor's `ses` check ([§10](#10-doctor)) |

AWS operation and field names beyond those cited in Domains on any DNS host (for example the
receipt-rule-set calls, `CreateAccessKey` and the subscription status): verify at build time.

**Exit codes** ([§3.4](#34-exit-codes)):

| Code | When |
|---|---|
| 0 | Done, or nothing to change |
| 2 | `--region` missing or not a receiving region; a region outside the EU and the UK with `PM_JURISDICTION = "eu"` and no `--allow-non-eu`; the deployed version differs from the CLI's; the policy review declined, or not answered in a non-interactive run without `--yes` |
| 3 | No AWS credentials; no `deploy/wrangler.toml`; missing `CLOUDFLARE_API_TOKEN` or account ID |
| 9 | The Worker's `/health` does not answer |
| 10 | Wrangler (`secret put`, deploy) or a Cloudflare API call failed |
| 13 | The SNS subscriptions were not confirmed within 5 minutes |
| 14 | An AWS API call failed, or the account has no SES production access |
| 130 | Interrupted |

JSON mode prints `{ "region", "rule_set", "steps": [ { "step", "status", "resource", "id" } ],
"policy": { … }, "warnings": [ … ] }`. The access key never appears in it.

## 7. Rendering `wrangler.toml`

`bundle/render.rs` renders `<dir>/wrangler.toml` from the bundle's `deploy/wrangler.toml.tmpl` (or the
repository's template with `--from-source`). The output is the file in
[Rust workspace §8](rust-workspace.md#8-generated-wranglertoml).

1. **Inputs**, highest priority first: the values `setup` or `setup ses` learned in this run (resource
   IDs, flags); the values in the existing `<dir>/wrangler.toml`, if any; the template's defaults.
2. **Preserved operator edits.** Every key under `[vars]` keeps its existing value, so a deployer who
   sets `PM_TRUSTED_AUTHSERV_ID` or `PM_EMBED_MODEL` in the file keeps it across `deploy` and
   `upgrade`. `PM_CONSOLE_HOST` (default: the API host), `PM_SIGNUP` (default `"closed"`),
   `PM_WEB_BOT_AUTH` (default `"off"`, [Agent signing keys §9](agent-keys.md#9-configuration)),
   `PM_IDENTITY_KEY_OVERLAP_DAYS` (default `"7"`) and `PM_NOTIFICATIONS` (default `"on"`,
   [Notifications](notifications.md)) are always written, so the operator sees them. Optional variables
   are written only when set: `PM_AI_GATEWAY`,
   `PM_SES_REGION`, `PM_SES_SNS_TOPIC_ARN`, `PM_SES_INBOUND_BUCKET`, `PM_SES_INBOUND_TOPIC_ARN`,
   `PM_SES_INBOUND_QUEUE_URL`, `PM_SES_RULE_SET`, `PM_CF_SUBDOMAIN_SETUP`, `PM_DAILY_SEND_QUOTA`,
   `PM_BACKUP_BUCKET`, `PM_SCANNER_URL`, `PM_SECURITY_CONTACT`, and the other console, sign-up and
   billing variables of [Configuration › Variables](../../reference/configuration.md#variables).
   The `[observability.traces]` table is preserved too: its `enabled` and `head_sampling_rate` keep
   their existing values, and the template's default (`enabled = false`) is written only when the table
   is missing. Staging sets `enabled = true` and `head_sampling_rate = 0.1` once, and `deploy` and
   `upgrade` keep it. Staging carries only synthetic mail ([Testing §10](testing.md#10-live-end-to-end-suite-live)).
3. **Owned sections.** Bindings, Durable Object migrations, queues, cron triggers, limits and
   observability come from the template. They include the `Q_DELIVERY` producer (used only by
   `POST /v1/platform/dlq/{dlq_id}/redrive` to republish dead-lettered delivery events), the six Durable
   Object bindings including `NOTIFY` (class `Notifier`, [Notifications §8](notifications.md#8-notifier-object)),
   the six rate-limit bindings including `RL_SIGNIN` (10 requests per 60 s per client IP,
   [Cloud sign-up §10](cloud-signup.md#10-abuse-and-safety-on-cloud)) and `RL_SIGN` (600 signing calls
   per 60 s per identity, [Agent signing keys §6](agent-keys.md#6-permissions-limits-and-plans)), a
   second Custom Domain route when
   `PM_CONSOLE_HOST` differs from `PM_API_HOST`, and, when `PM_BACKUP_BUCKET` is set, the `BACKUP` R2
   binding in the deployment's jurisdiction. Edits to them are not preserved; the renderer prints a
   unified diff of what it changed and, in interactive mode, asks before writing when a non-`[vars]`
   line would change.
4. **Placeholders** `{…}` that remain after merging are an error naming the missing value.
5. **Validation**: the result must parse as TOML; `PM_PLATFORM_DOMAIN`, `PM_API_HOST` and
   `PM_JURISDICTION` must equal the values in the D1 platform domain row once it exists (a mismatch
   means the file was copied from another deployment: exit 3).
6. The file is written atomically, mode `0644` (it holds no secrets).

## 8. `deploy`

`pmail deploy [--version <v>] [--from-source [--source-dir <path>]] [--gradual] [--stages <list>] [--stage-wait <duration>] [--force] [--dir <path>]`

### 8.1 Bundle download

1. The version is `--version`, else the CLI's own version. A version newer than the CLI is refused
   (exit 2): the CLI implements the setup steps and migration runner for its own release.
2. `GET https://api.github.com/repos/PILOTAAI/pylota-mail/releases/tags/v{version}` with
   `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2026-03-10`; a `404` is exit 2
   ("no such release"). From `assets[]`, take the `browser_download_url` of
   `pylota-mail-worker-{version}.tar.gz`, `SHA256SUMS` and `SHA256SUMS.sig`.
3. Download each to `<dir>/.bundle/{version}.partial/` with caps: `SHA256SUMS` ≤ 64 KB,
   `SHA256SUMS.sig` ≤ 4 KB, the tarball ≤ 64 MiB. HTTPS only; at most 5 redirects, each to an `https`
   URL. `HTTPS_PROXY` is honoured.

### 8.2 Signature and checksums

**Choice: minisign** (Ed25519 signatures in the minisign format), verified with the `minisign-verify`
crate (pin at build time; "a small Rust library with no external dependencies", crates.io, read
2026-10-09). The `SHA256SUMS.sig` file produced by `cargo xtask release`
([Rust workspace §9](rust-workspace.md#9-xtask)) is a minisign signature of `SHA256SUMS`.

Why minisign rather than cosign:

- **Offline and self-contained.** The public key is compiled into `pmail`; verification needs no
  network service. Keyless cosign verification depends on Sigstore's certificate authority and
  transparency log being reachable and on trusting an OIDC identity, which adds failure modes to every
  deploy.
- **Small trusted code.** One dependency-free crate doing Ed25519 over a short file, against the
  Sigstore client stack (TUF, X.509, Rekor clients) compiled into a CLI that must build for five
  targets.
- **Provenance is still available.** Releases also carry GitHub build provenance from
  `actions/attest@v4`, verifiable with `gh attestation verify` ([Security](security.md)). That is the
  deeper supply-chain check for those who want it; minisign is the mandatory gate on every deploy.

Verification:

1. Parse `SHA256SUMS.sig` (untrusted comment, signature line, trusted comment, global signature).
   The signature's key ID must equal one of the compiled-in key IDs. The CLI carries two keys,
   `current` and `next`, so the signing key can be rotated with a release that adds the next key
   before it is used.
2. Verify the signature over the exact bytes of `SHA256SUMS`, and the global signature over the
   signature plus the trusted comment. The trusted comment must be `pylota-mail v{version}`, so a
   valid signature from another release cannot be replayed.
3. Parse `SHA256SUMS`: lines `<64 lower-case hex>␠␠<filename>`; filenames match
   `^[A-Za-z0-9._-]{1,128}$`; no duplicates.
4. Compute SHA-256 of the tarball while it streams to disk; it must equal its line. A missing line, a
   mismatch, or any signature failure is **exit 11**, the partial directory is deleted, and nothing is
   deployed. There is no flag to skip verification (FR-OPS-2).

### 8.3 Extraction

The tarball is extracted to `<dir>/.bundle/{version}.partial/` and renamed to `<dir>/.bundle/{version}/`
when complete. Rules:

- Only regular files and directories. Symbolic links, hard links, devices and FIFOs are refused.
- Every path is relative, has no `..` component, no leading `/`, no drive prefix, and stays inside the
  target after normalisation. At most 1,000 entries and 128 MiB unpacked.
- Expected contents: `build/index.js`, `build/index_bg.wasm`, `build/worker/shim.mjs`,
  `migrations/d1/*.sql`, `deploy/wrangler.toml.tmpl`, `VERSION`. `VERSION` must equal the requested
  version. Any missing file is exit 11.

### 8.4 Order of a deploy

```text
verify bundle ─► render wrangler.toml ─► index generation check (§8.7)
      ─► D1 migrations ─► code (wrangler deploy, or gradual §8.6) ─► health ─► doctor subset
```

- **Migrations before code.** D1 changes are expand-then-contract
  ([Architecture §7](../architecture.md#7-deployment-topology)): a release only adds what its code
  needs, so the running (older) code keeps working against the expanded schema while the new code rolls
  out. Durable Object SQLite migrations are applied by each object on wake, idempotently
  ([J9](../edge-cases.md)); the CLI does not touch them.
- A migration failure stops the deploy before any code changes (exit 10).

### 8.5 D1 migrations

`bundle/migrate.rs` applies `migrations/d1/NNNN_name.sql` in numeric order through
`POST /accounts/{a}/d1/database/{database_id}/query`:

1. `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`. When it is
   absent, the database is new and every migration is pending (0001 creates `schema_migrations`).
2. `SELECT version FROM schema_migrations`.
3. For each file with a version not in the table, send one request whose `sql` is the file's text
   followed by `INSERT INTO schema_migrations (version, applied_at) VALUES ({version}, {now_ms});`.
   The query API runs multiple statements as a batch.
4. Versions present in the table but absent from the bundle (the database is newer than the code being
   deployed) are allowed for a one-release rollback and reported as a warning; more than one such
   version is refused (exit 10), matching the expand-then-contract rule.

Whether a multi-statement request to the D1 query API is atomic is not stated in the API reference.
Spike S1 checks it: its pass criteria include "a multi-statement D1 query-API request is atomic"
([Design › Spikes](index.md#spikes)). **Fallback if it is not:** every migration file must be
re-runnable (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `INSERT OR IGNORE`), the
`schema_migrations` insert stays the last statement of the request, and a CI lint over `migrations/d1/`
enforces both from then on. A request that fails part-way is then simply sent again by the next
`pmail deploy`. Until v1.0 there is one migration, `0001_init.sql`
([Build plan › M5](../build-plan.md#m5--worker-base-routing-auth-tenants-keys)).

Local integration tests apply the same files with `wrangler d1 migrations apply --local`
([Testing §6.1](testing.md#61-what-cargo-xtask-itest-does)); that path records Wrangler's own table
in the throwaway local database and never meets a deployed one.

### 8.6 Code deploy and the gradual flag

**Default (`--gradual` off).** `npx --yes wrangler@4.139.0 deploy --config <dir>/wrangler.toml
--message "pmail deploy v{version}"`, run with the bundle directory as working directory, so `main =
"build/index.js"` resolves. Wrangler's output is captured; on failure its last 40 lines are printed and
the exit code is 10.

**`--gradual`** (the default for `upgrade`). Versions follow the architecture's rollout,
10% → 50% → 100% ([Architecture §7](../architecture.md#7-deployment-topology)):

1. **Durable Object class changes force a full deploy.** If the rendered `[[migrations]]` tags differ
   from the deployed ones (read from the previous rendered file), the change cannot be uploaded as a
   version (Cloudflare deployment management, read 2026-10-09), so the CLI says so and uses the default
   path at 100%.
2. `wrangler versions upload --config … --message "pmail v{version}" --tag v{version}` and read the new
   version ID from its output. `wrangler deployments list` gives the currently deployed version ID.
3. **Smoke test at 0%:** `wrangler versions deploy {new}@0% {old}@100% -y`, then
   `GET https://{api_host}/health` with `Cloudflare-Workers-Version-Overrides: pylota-mail="{new}"`
   must return `200` with the new `version`.
4. For each stage `p` in `--stages` (default `10,50,100`): `wrangler versions deploy {new}@{p}%
   {old}@{100-p}% -y` (at 100: `{new}@100%`), then wait `--stage-wait` (default 10 minutes; 0 allowed),
   polling every 30 s: `/health` with the override header, and the `alerts` and `dlq` doctor checks.
5. **Abort** on any failure, on Ctrl-C, or on a firing alert that was not firing before the deploy:
   `wrangler versions deploy {old}@100% -y`, report which check failed, exit 10. D1 migrations already
   applied stay (they are expansions).

During a gradual deployment each Durable Object runs one version at a time (Gradual deployments with
Durable Objects, read 2026-10-09); mailbox schema migrations run on wake and are idempotent
([J9](../edge-cases.md)).

### 8.7 Index generation changes

[Search §7.3](search.md#73-re-embed-job-embedding-model-change) defines the re-embed process. The CLI's
part runs in every `deploy` and `upgrade`, after rendering and before migrations:

1. Read `PM_EMBED_MODEL` from the rendered `[vars]`, the index bound to `VECTORS` (`[[vectorize]]`),
   and whether a `VECTORS_NEXT` binding and `PM_EMBED_MODEL_PREVIOUS` are present.
2. Read the model of the bound index from its description
   (`GET /accounts/{a}/vectorize/v2/indexes/{name}`; setup wrote
   `pylota-mail generation=N embed_model=…`).
3. Decide:

| State | Action |
|---|---|
| No `VECTORS_NEXT`, model equals the index's model | Nothing |
| No `VECTORS_NEXT`, model differs | **Start.** Embed a probe through `POST /accounts/{a}/ai/run/{model}` with `{"text":["pylota-mail dimension probe"]}` and take the length of `data[0]` (the `text` input is the one `bge-m3` takes; another model's input schema is checked on its model page first). Create `pm-mail-chunks-g{N+1}` with that dimension, `metric: cosine`, description `pylota-mail generation={N+1} embed_model={model}`, and the eight metadata indexes. Render with `VECTORS` → old index, `VECTORS_NEXT` → new index, `PM_EMBED_MODEL` → new model, `PM_EMBED_MODEL_PREVIOUS` → old model. Ask for confirmation in interactive mode, printing the cost note from Search §7.3 |
| `VECTORS_NEXT` present, `PM_EMBED_MODEL` equals `PM_EMBED_MODEL_PREVIOUS` | **Cancel.** The deployer set the model back. Render without `VECTORS_NEXT` and `PM_EMBED_MODEL_PREVIOUS`; the Worker cancels the `reembed` job when the binding disappears. The orphan index is offered for deletion |
| `VECTORS_NEXT` present, job not completed | Nothing; print progress from `SELECT status, result_json FROM jobs WHERE kind = 'reembed' ORDER BY created_at DESC LIMIT 1` |
| `VECTORS_NEXT` present, latest `reembed` job `completed` | **Finalise.** Render with `VECTORS` → the new index and without `VECTORS_NEXT` and `PM_EMBED_MODEL_PREVIOUS`; after the deploy succeeds, offer to delete the old index (`DELETE /accounts/{a}/vectorize/v2/indexes/{old}`; never without confirmation) |

`doctor` reports a completed job that has not been finalised as a `warn` on `bindings`, with the fix
`pmail deploy`.

`VECTORS_NEXT` and `PM_EMBED_MODEL_PREVIOUS` are defined by Search §7.3 and listed in
[Configuration › Bindings](../../reference/configuration.md#bindings) and
[› Variables](../../reference/configuration.md#variables).

### 8.8 `--from-source`

Builds from a local checkout of the repository at the matching tag, named by `--source-dir` (default:
the current directory; a directory without `crates/worker` is exit 2):

1. Check `rustup target list --installed` includes `wasm32-unknown-unknown`, else exit 10 with the
   install command.
2. `cargo install worker-build --version 0.8.7 --locked` (skipped when `worker-build --version`
   already prints 0.8.7), then `worker-build --release` in `<source-dir>/crates/worker`
   ([Rust workspace §8](rust-workspace.md#8-generated-wranglertoml)).
3. Use the checkout's `migrations/d1/` and `deploy/wrangler.toml.tmpl`. No signature applies; the
   CLI prints the commit (`git rev-parse HEAD`) and a warning that the build is unverified.

`--from-source` avoids the GitHub Releases download, not the network: Cargo still needs crates.io for
`worker-build` and the workspace's dependencies, unless the crates are vendored (`cargo vendor`) and
`worker-build` 0.8.7 is already installed, and `npx` still fetches Wrangler from the npm registry unless
it is in the npx cache. What else `worker-build` downloads while it builds: verify at build time.

### 8.9 No-op redeploys

After a successful deploy the CLI writes `# pmail: deployed v{version} sha256={hash of the rendered
file without this line}` as the last line of `wrangler.toml`. `deploy` exits 0 without calling
Wrangler when that line matches, migrations are up to date, and `/health` reports the same version.
`--force` deploys anyway.

### 8.10 Output

```text
Verified pylota-mail-worker-1.0.0.tar.gz (minisign key 7A3F…, sha256 9c1e…)
Rendered deploy/wrangler.toml (no changes)
D1 migrations: 0 pending
Deployed v1.0.0 (version 095f00a7-…) to https://mail.example.com
Health: ok
```

JSON: `{ "version", "worker_version_id", "migrations_applied": [ … ], "gradual": { "stages": [ … ] } | null, "index_generation": "unchanged|started|finalised|canceled|in_progress" }`.

## 9. `upgrade`

`pmail upgrade [--stages 10,50,100] [--stage-wait 10m] [--no-gradual] [--dir <path>]`

1. `GET https://api.github.com/repos/PILOTAAI/pylota-mail/releases/latest`. If its tag is newer than
   the CLI, print "pmail {cli} is older than the latest release {latest}; install the new CLI first"
   with the install commands, and exit 2. The CLI's version decides the Worker version.
2. `GET https://{api_host}/health`. If the deployed version equals the CLI's, exit 0 ("up to date").
   If the deployed version is newer than the CLI's, refuse (exit 2): that would be a rollback, which is
   `pmail deploy --version <v>`.
3. Run `deploy` with `--gradual` (unless `--no-gradual`), including the index generation check.
4. Run `doctor` and print its result. A doctor failure after an upgrade is exit 12; the new version
   stays deployed (the gradual stages already checked health and alerts).

## 10. `doctor`

`pmail doctor [--mail-test] [--check <name>]… [--dir <path>]`

The checks, their failure conditions and fixes are defined in
[Observability §7.2](observability.md#72-pmail-doctor). This section defines how the CLI runs them.

- Each check returns `pass`, `warn`, `fail` or `skip` (a prerequisite is missing, for example no API
  key for `alerts`). Checks run concurrently, at most 8 at a time, each with a 20-second timeout
  (`mail_test`: 150 s); a timeout is `fail` with reason `timeout`.
- A Cloudflare API error inside a check makes that check `fail`, with the step and the Cloudflare error
  codes in `detail` (the one exception is `quota`, below). `doctor` therefore never exits 10.
- Human output: one line per check, then a summary.

  ```text
  pass  dns.platform                 MX, SPF, DKIM, DMARC match on both resolvers
  fail  routing.catch_all            catch-all is disabled
        fix: pmail setup (step 17), or PUT /zones/{zone_id}/email/routing/rules/catch_all …
  warn  security_txt                 PM_SECURITY_CONTACT is not set
  13 passed, 1 warning, 1 failed
  ```

- JSON: `{ "checks": [ { "name", "status", "detail", "fix" } ], "summary": { "pass", "warn", "fail", "skip" } }`.
- Exit 0 with no `fail`; 12 otherwise.
- `--check` runs only the named checks.

Data sources:

| Check | Source |
|---|---|
| `dns.platform` | Expected records from `GET /zones/{z}/email/routing/dns` and `GET /zones/{z}/email/sending/subdomains/{tag}/dns`; observed through both `PM_DOH_RESOLVERS` from the rendered file, parsed with `core::dns` |
| `routing.catch_all` | `GET /zones/{z}/email/routing/rules/catch_all` |
| `sending.domains` | D1 `SELECT name, zone_id FROM domains WHERE sending = 1 AND transport = 'cloudflare' AND state <> 'removed'`, then `GET /zones/{z}/email/sending/subdomains` per zone (`preview_enabled`) |
| `sending.event_subscriptions` | `GET /accounts/{a}/event_subscriptions/subscriptions` compared with the same domains and each row's `event_subscription_id` |
| `bindings` | D1, R2 (with the jurisdiction header), queues and their consumers (`GET /accounts/{a}/queues/{queue_id}/consumers`), the Vectorize index and its metadata indexes, as declared in the rendered file; plus the index generation state of [§8.7](#87-index-generation-changes). A bound index's dimensions are compared with those of the model named in its description (1,024 for `@cf/baai/bge-m3`, otherwise a probe embedding as in §8.7), never with a fixed number, because a re-embed may create an index of another dimension |
| `secrets` | `GET /accounts/{a}/workers/scripts/pylota-mail/secrets` (names only). `warn` only while `PM_MASTER_KEY_NEXT` is present (an unfinished master-key rotation, [§12.1](#121-secrets-rotate-master)) |
| `observability` | The rendered file's `[observability]` table |
| `worker.version`, `health` | `GET https://{api_host}/health` |
| `alerts` | `GET /v1/audit-events?action=alert.fired` and `?action=alert.resolved` with the profile's key (needs `audit:read`; `skip` without it) |
| `dlq` | D1 `SELECT queue, COUNT(*) AS n, MIN(first_seen_at) AS oldest FROM dlq_items WHERE redriven_at IS NULL GROUP BY queue` |
| `quota` | Workers Analytics Engine SQL API (`POST /accounts/{a}/analytics_engine/sql`; verify at build time) over the `provider_quota_errors_total` points of the last 24 hours ([Observability §3](observability.md#3-metrics)). `warn` when `PM_DAILY_SEND_QUOTA` is unset in the rendered file, with the fix `pmail setup --daily-send-quota <n>` (or set it under `[vars]` and `pmail deploy`). The SQL API needs Account Analytics · Read on the token (Cloudflare's SQL API page, read 2026-10-09); when the call is refused for a missing permission, the check is `warn`, not `fail`, with the fix naming that permission ([Deploy to Cloudflare › step 2](../../self-hosting.md#2-create-a-cloudflare-api-token)) |
| `ses` | Only when `PM_SES_REGION` is set in the rendered file (otherwise `skip`); needs local AWS credentials ([§2.6](#26-aws-credentials); `skip` without them). `fail` when: SES `GetAccount` shows no production access, or sending paused; `PM_SES_INBOUND_TOPIC_ARN` is set and the active receipt rule set is not `PM_SES_RULE_SET` or does not contain `pm-deliver`; `PM_SES_REGION` is not a receiving region. `warn` when the region is outside the EU and the UK under `PM_JURISDICTION = "eu"` (only possible through `setup ses --allow-non-eu` or a hand edit, [N30](../edge-cases.md)). Identity count from D1, the same count the Worker uses: `SELECT COUNT(*) FROM domains WHERE ses_region IS NOT NULL AND state <> 'removed'`, plus 1 for the platform identity. At 9,000 or more, `warn` `ses_identities_90pct` ([N26](../edge-cases.md)); at 10,000, `fail` (new SES domains are refused with `transport_unavailable`, `ses_identity_limit`). SES allows 10,000 identities per region (SES quotas, read 2026-10-09). Field and call names beyond `GetAccount`: verify at build time |
| `cloudflare.zones` | `GET /zones?account.id={a}`: the number of zones in the account, always printed in the detail. Never `fail`; `warn` above 1,000, with the fix "ask Cloudflare to confirm the account's zone limit": the limit for a non-Enterprise account is not documented ([Domains on any DNS host §3.2](domain-connections.md#32-nameservers)) |
| `security_txt` | `GET https://{api_host}/.well-known/security.txt` (`Expires`) and `PM_SECURITY_CONTACT` in the rendered file |
| `web_bot_auth` | Only when `PM_WEB_BOT_AUTH = "on"` in the rendered file (otherwise `skip`). `GET https://{api_host}/.well-known/http-message-signatures-directory`, no key. `fail` unless it answers `200` with `Content-Type: application/http-message-signatures-directory+json`, lists one to three keys, and carries one `Signature-Input` and `Signature` member per listed key, with tag `http-message-signatures-directory`, that verifies with that key (`core::httpsig`; [Agent signing keys §3.2](agent-keys.md#32-web-bot-auth-key-directory)). The fix names the deploy step or the key rotation |
| `mail_test` | Below |

**`--mail-test`.** Needs a key that holds, in the default tenant, `identities:read` and
`identities:write` (step 1), `messages:send` (step 2), `search:read` (`wait`, step 3), `messages:read`
(the raw message, step 4) and `erasure:manage` (step 5). The platform key that setup creates holds them;
without one of them the check is `fail` with the missing permission in `detail`.

1. Create or reuse the identity `pmail-doctor` in the default tenant (`client_id: "pmail:doctor"`,
   owner = the setup owner or `postmaster@{mail_domain}` as a placeholder the operator sees).
2. Send from it to its own platform address `pmail-doctor@{mail_domain}`, subject
   `pmail doctor {ulid}`, `Idempotency-Key: pmail-doctor-{ulid}`.
3. `GET /v1/identities/{id}/wait?subject_contains=pmail%20doctor%20{ulid}&timeout=60`, twice at most.
4. `pass` when the inbound copy arrives with `trust.verdict: "pass"`. The detail prints the
   `Authentication-Results` authserv-id seen on the raw message (`GET …/messages/{id}/raw`, first such
   header), for `PM_TRUSTED_AUTHSERV_ID`.
5. Erase the two test messages (`DELETE …/messages/{id}`), so the check leaves no mail behind.

## 11. `destroy`

`pmail destroy [--dry-run] [--confirm <platform-domain>] [--skip-erasure] [--keep-dns] [--include-ses] [--dir <path>]`

Deletes the deployment and every Cloudflare resource setup created, and, with `--include-ses`, the AWS
resources `setup ses` created. It is irreversible: point-in-time recovery cannot bring back a deleted
database or bucket.

**Safety.**

- The typed confirmation is mandatory: interactive runs ask the operator to type the platform domain;
  non-interactive runs need `--confirm agents.example` matching `PM_PLATFORM_DOMAIN`. `--yes` does not
  replace it.
- `--dry-run` prints the plan (every resource with its ID, the tenants and their identity counts) and
  exits 0 without changing anything. Every real run prints the same plan first.
- The resources are found from the rendered file and verified by name in the account before anything
  is deleted, so a stale file cannot point the command at someone else's resources.
- **AWS resources.** When the rendered file holds `PM_SES_REGION`, the plan lists the resources
  `setup ses` created ([§6.9](#69-setup-ses): the names there and the `PM_SES_*` variables). Without
  `--include-ses` they are marked "left in place" and are not touched, and the final output repeats the
  list, warning that the IAM user's access key stays valid until someone deletes it in the AWS console.
  With `--include-ses`, the local AWS credentials ([§2.6](#26-aws-credentials)) are checked before
  anything is deleted (exit 3 without them) and step 4 deletes the resources.

**Order.**

1. **Stop new mail.** `PUT /zones/{z}/email/routing/rules/catch_all` with `"enabled": false`.
2. **Erase every tenant** through the product, unless `--skip-erasure`: for each tenant,
   `POST /v1/erasure-requests` `{"tenant_id": …, "scope": "tenant", "reason": "pmail destroy"}`, then
   poll `GET /v1/erasure-requests/{id}` until `completed` or `completed_with_holds` (deadline 2 hours;
   exit 13 after it, and a re-run resumes). This wipes mailboxes, R2 objects and vectors through the
   tested erasure path and removes tenant domains' routing, sending and subscriptions. An erasure skips
   threads under a legal hold and ends `completed_with_holds`, listing them in its receipt (FR-PRV-4).
   Deleting the storage in steps 5 and 6 would destroy that held mail, so the CLI then lists the held
   threads per tenant and stops with exit 6 (`conflict`) before step 3. A person releases the holds (or
   exports the mail and then releases them) and runs `destroy` again; the erasure re-runs and now
   removes those threads.
   `--skip-erasure` is for a Worker that no longer answers.
3. **Tear down remaining domains.** For each row left in `domains` (always the platform domain), the
   removal steps of [Identities, addresses and domains › Domain removal](identity-domains.md#domain-removal)
   with the local token: literal rules, catch-all disabled, `DELETE /zones/{z}/email/routing/dns`
   (unless `--keep-dns`), `DELETE /zones/{z}/email/sending/subdomains/{tag}`, the event subscription,
   and the ownership TXT. SES identities are left to step 4.
4. **Amazon SES resources** (only with `--include-ses`; otherwise listed as above). With the local AWS
   credentials, in the reverse order of [§6.9](#69-setup-ses): the two HTTPS subscriptions; the Worker's
   access key, then the IAM user `pylota-mail-worker` and its policy; the SES identities of every domain
   row that still has `ses_identity` (left by `--skip-erasure`) and the platform identity, with the
   platform identity's DKIM CNAMEs removed from its zone through the Cloudflare API; the configuration
   set, its event destination and the delivery-events topic; the receipt rule `pm-deliver`, and the rule
   set `pylota-mail` only when setup created it (an operator's own active rule set is kept, without the
   rule); the SQS queue and its subscription; the inbound SNS topic; the inbound S3 bucket, emptied
   first (it holds raw mail for at most 14 days). Each step reads first and treats AWS's not-found error
   as done; any other AWS error is exit 14, and a re-run continues. Operation names beyond those cited in
   [Domains on any DNS host §4.2](domain-connections.md#42-deployment-set-up-for-ses): verify at build
   time.
5. **Delete the Worker:** `npx --yes wrangler@4.139.0 delete --name pylota-mail`. Wrangler describes
   this as deleting the Worker and its associated resources; whether the Durable Object namespaces'
   storage is removed with it is verified at build time. After step 2 no mail content remains in them.
6. **Delete storage:** every Vectorize index named `pm-mail-chunks*`
   (`DELETE /accounts/{a}/vectorize/v2/indexes/{name}`); the ten queues
   (`DELETE /accounts/{a}/queues/{queue_id}`); the R2 bucket (`DELETE /accounts/{a}/r2/buckets/pylota-mail-blobs`
   with the jurisdiction header), and the `BACKUP` bucket when `PM_BACKUP_BUCKET` is set. R2 refuses to
   delete a bucket that still holds objects; staging objects expire within a day by the lifecycle rule,
   so the CLI reports the bucket as pending and a re-run the next day finishes. The tenant erasures of
   step 2 sweep the backup bucket too ([Privacy §5.4](privacy.md#54-optional-r2-backup-copy)); an object
   left in it is reported the same way. Last, the D1 database (`DELETE /accounts/{a}/d1/database/{id}`).
7. Remove the profile's key (it no longer works) and rename `<dir>/wrangler.toml` to
   `wrangler.toml.destroyed`.

Each step is idempotent; a `404` carrying Cloudflare's own "not found" code counts as done, any other
`404` is an error (the same rule as domain removal).

## 12. Secrets

### 12.1 `secrets rotate-master`

The procedure is [Security §6.2](security.md#62-rotation-procedures). The CLI's part:

1. Refuse if `PM_MASTER_KEY_NEXT` already exists (a rotation is in progress) unless `--resume`.
2. Generate `K2` (32 bytes, OS CSPRNG) and compute `kid(K2)` = first 8 bytes of `SHA-256(K2)`, lower-case
   hex ([Security §7.2](security.md#72-encryption-envelope)). Upload it with
   `wrangler secret put PM_MASTER_KEY_NEXT` (value on stdin).
3. Poll every 60 s through the D1 query API until the count is 0. The query is built from the
   sealed-column registry (`core::sealed`, [Security §7.2](security.md#72-encryption-envelope)), one term per
   column; for v1.0 it reads:

   ```sql
   SELECT
     (SELECT COUNT(*) FROM webhook_endpoints WHERE secret_enc NOT LIKE 'pm1.' || ?1 || '.%')
   + (SELECT COUNT(*) FROM webhook_endpoints WHERE prev_secret_enc IS NOT NULL
                                               AND prev_secret_enc NOT LIKE 'pm1.' || ?1 || '.%')
   + (SELECT COUNT(*) FROM identity_keys WHERE private_enc NOT LIKE 'pm1.' || ?1 || '.%')
   + (SELECT COUNT(*) FROM signing_keys WHERE ciphertext NOT LIKE 'pm1.' || ?1 || '.%')
   + (SELECT COUNT(*) FROM domains WHERE smtp_sealed IS NOT NULL
                                     AND smtp_sealed NOT LIKE 'pm1.' || ?1 || '.%')
   + (SELECT COUNT(*) FROM domains WHERE smtp_pending_sealed IS NOT NULL
                                     AND smtp_pending_sealed NOT LIKE 'pm1.' || ?1 || '.%')
   + (SELECT COUNT(*) FROM users WHERE totp_sealed IS NOT NULL
                                   AND totp_sealed NOT LIKE 'pm1.' || ?1 || '.%')
   + (SELECT COUNT(*) FROM users WHERE recovery_codes_sealed IS NOT NULL
                                   AND recovery_codes_sealed NOT LIKE 'pm1.' || ?1 || '.%')
   + (SELECT COUNT(*) FROM oauth_states WHERE pkce_sealed NOT LIKE 'pm1.' || ?1 || '.%') AS remaining;
   ```

   The columns are every value sealed under `PM_MASTER_KEY`, the same registry the Worker's re-seal sweep
   reads.

   printing the count each time. With `--resume`, `K2` is not known; the CLI reads the target `kid`
   from the most common `kid` among rows already re-sealed and asks for confirmation.
4. Upload `PM_MASTER_KEY = K2`, then delete `PM_MASTER_KEY_NEXT` (`wrangler secret delete
   PM_MASTER_KEY_NEXT --name pylota-mail`), then drop `K2` from memory.
5. Deadline 24 hours (exit 13; `--resume` continues).

`PM_MASTER_KEY_NEXT` is defined by Security §6.2 and listed in
[Configuration › Secrets](../../reference/configuration.md#secrets). While it is set, `doctor` warns
(`secrets`).

### 12.2 Signing keys: `keys rotate thread|link|cursor|web_bot_auth`

`pmail keys rotate thread|link|cursor|web_bot_auth [--revoke-previous] [--yes]`

The keys that sign thread tokens, links and console tokens, search cursors, and Web Bot Auth HTTP
signatures with their key directory are not Worker secrets: the Worker generates them into D1
`signing_keys` ([Security §6.2](security.md#62-rotation-procedures),
[Agent signing keys §2](agent-keys.md#2-keys)). The command calls
`POST /v1/platform/keys/{purpose}/rotate`, with `?revoke_previous=true` when `--revoke-previous` is
given, using a platform key with `platform:ops`. It needs no Cloudflare credentials, and no secret is ever
read back: the API returns key IDs, never key material.

- **One command, two meanings.** The first argument decides. `thread`, `link`, `cursor` or
  `web_bot_auth` rotates that signing key. An argument starting with `key_` rotates an API key, as before
  (`POST /v1/keys/{key_id}/rotate`, with `--overlap-hours`). Anything else is exit 2. `--revoke-previous`
  with a `key_…` argument, and `--overlap-hours` with a purpose, are exit 2, so a mistyped command never
  does the other thing.
- **`web_bot_auth`.** Its key IDs are 43-character JWK thumbprints, where the other purposes use one
  character. While `PM_WEB_BOT_AUTH` is `off` the API answers `422 web_bot_auth_disabled` (exit 7).
- **Confirmation.** Interactive runs ask first, naming the purpose and how long the previous key keeps
  verifying: 90 days (`thread`), 7 days (`link`), 24 hours (`cursor`), 7 days in the key directory
  (`web_bot_auth`). With `--revoke-previous` the prompt says what stops working at once: thread tokens
  fall back to header threading; open download links, console sign-in links, invitations, sessions and
  OAuth flows under the old `link` key fail; open search cursors fail with `400`; for `web_bot_auth`, the
  old key leaves the directory, so signatures made with it fail at verifiers once they fetch the
  directory again (it may be cached for up to 24 hours). Non-interactive runs need `--yes` (exit 2
  otherwise).
- **Output.** Human mode:

  ```text
  Rotated thread key: new kid 4 (2026-10-09T10:00:00Z)
  Previous kid 3 verifies until 2027-01-07T10:00:00Z
  ```

  With `--revoke-previous` the second line is `Previous kid 3: revoked`. A `web_bot_auth` kid is printed
  in full. `--json` prints the response unchanged (`purpose`, `kid`, `created_at`, `previous.kid`,
  `previous.verify_until`, `previous.revoked`).
- After a suspected leak of a signing key: rotate it with `--revoke-previous`, then run
  `pmail secrets rotate-master` ([§12.1](#121-secrets-rotate-master)), because reading a signing key
  needs both D1 access and `PM_MASTER_KEY`.

### 12.3 Other secrets

`PM_CF_API_TOKEN` and the SES keys (`PM_SES_ACCESS_KEY_ID`, `PM_SES_SECRET_ACCESS_KEY`) rotate with
`wrangler secret put` as listed in Security §6.2; the CLI does not wrap them, and a re-run of
`setup ses` never replaces an existing SES key ([§6.9](#69-setup-ses)). `PM_KEY_PEPPER` rotates only
through `pmail setup --rotate-pepper` ([§6.5](#65-the-bootstrap-key)). `PM_HASH_KEY` is not rotatable in
v1.0.

## 13. `dlq`

Defined in [Observability §8.3](observability.md#83-listing-and-redriving). Both commands are calls to the
platform API with a platform key holding `platform:ops`
([REST API › Platform operations](../../reference/api.md#platform-operations)). The CLI makes no D1
query, Queues API call or Cloudflare call, and needs no Cloudflare credentials: the Worker republishes
through its own producer bindings.

- `pmail dlq list [--queue <name>] [--status open|redriven] [--tenant <tenant>] [--limit <n>] [--all]`
  calls `GET /v1/platform/dlq` with the filters `queue`, `status` (default `open`), `tenant_id`,
  `limit` and `cursor`. Human mode shows ID, queue, kind, tenant, age and redrive count. The API never
  returns the stored body (inbound pointers carry envelope addresses), so the CLI has nothing to redact.
  `--json` prints the response unchanged.
- `pmail dlq redrive (<dlq-id>… | --queue <name> [--tenant <tenant>]) [--yes]` calls
  `POST /v1/platform/dlq/{dlq_id}/redrive` once per item, each with its own generated
  `Idempotency-Key`. With `--queue`, the CLI first lists the open items as `list --all` does, prints the
  count and asks for confirmation (non-interactive runs need `--yes`). One line per item; a failed item
  is reported and the rest continue. The exit code is that of the first failure, or 0. JSON:
  `{ "redriven": [ … items … ], "failed": [ { "id", "error" } ] }`. Consumers are idempotent
  ([Design conventions §7](index.md#7-idempotent-queue-consumers)), so repeating a redrive is safe.

## 14. `login` and `config`

- `pmail login [--profile <name>]` asks for the API URL and the key (the key with hidden input), calls
  `GET /v1/me`, and on `200` writes the profile named by `--profile`, default `default`
  ([§2.2](#22-precedence)); it prints the key's level, tenant, identity and permissions. With
  `--key-env NAME` or `--key-command CMD` it stores that source instead of the key. Non-interactive
  use: `--url` plus `PYLOTA_MAIL_KEY`. It warns when `PYLOTA_MAIL_KEY` will keep overriding the saved
  key (§2.2).
- `pmail config show` prints the resolved settings and where each came from (flag, environment, profile),
  with the key shown as `pmk_live_7k2m…` (prefix and lookup only).
- `pmail config set <key> <value> [--profile <name>]` sets `url`, `identity`, `tenant`, `account_id`,
  `key_env`, `key_command` or `default_profile`. Setting `key` this way is refused (it would land in
  shell history); use `pmail login`.

## 15. `mcp config`

`pmail mcp config [--client generic|claude-code|cursor] [--name pylota-mail]` prints configuration for
the current profile's URL. It never prints a key; the configuration references an environment
variable.

| `--client` | Output |
|---|---|
| `generic` (default) | `{ "mcpServers": { "pylota-mail": { "url": "https://mail.example.com/mcp", "headers": { "Authorization": "Bearer ${PYLOTA_MAIL_KEY}" } } } }` |
| `claude-code` | The command `claude mcp add --transport http pylota-mail https://mail.example.com/mcp --header "Authorization: Bearer $PYLOTA_MAIL_KEY"`, and the `.mcp.json` form with `"type": "http"` |
| `cursor` | The `~/.cursor/mcp.json` form with `"Authorization": "Bearer ${env:PYLOTA_MAIL_KEY}"` |

The client formats are documented in the [MCP reference](../../reference/mcp.md#connect-a-client). The
command also prints which tools the current key would see (`GET /v1/me` permissions mapped through
[MCP server §3](mcp.md#3-authentication-and-tool-filtering)).

## 16. `webhooks verify`

`pmail webhooks verify --secret-env WEBHOOK_SECRET (--headers <file> | --id <id> --timestamp <ts> --signature <sig>) [--body <file>] [--tolerance 300] [--now <unix>]`

Verifies a captured delivery offline, with the same rules as the receiving guide
([Receiving › verifying](../../guides/receiving.md)) and [Webhooks design](webhooks.md):

1. The secret comes from `--secret-env` (or `--secret`, with the process-list warning of
   [§2.2](#22-precedence)); it must start with `whsec_`; the rest is standard base64.
2. Headers come from `--headers` (a file of `Name: value` lines, case-insensitive names) or the three
   flags: `webhook-id`, `webhook-timestamp`, `webhook-signature`.
3. The body is read as bytes from `--body` or stdin, unchanged (no newline added or removed).
4. Content = `{webhook-id}.{webhook-timestamp}.{body}`; expected = standard base64 of
   `HMAC-SHA256(secret_bytes, content)`. The signature header is split on spaces; every `v1,` entry is
   compared in constant time. Valid when any entry matches.
5. The timestamp must be within `--tolerance` seconds (default 300) of `--now` or the clock.

Output: `valid` (exit 0), or `invalid: <reason>` (exit 11) where reason is `no_matching_signature`,
`timestamp_out_of_tolerance`, `malformed_secret` or `missing_header`. JSON:
`{ "valid": true, "matched": 1, "event_id": "evt_…" }`.

## 17. `ask`

`pmail ask "<question>" (--identity <id|address> | --tenant <tenant>) [--max-steps 6] [--max-seconds 8] [--include-quarantined] [--no-stream] [--show-trace] [--stream]`

1. `POST /v1/identities/{id}/search` with `{"q": question, "mode": "agentic", "budget": {...},
   "stream": true}` and `Accept: text/event-stream` (needs `search:read` and `search:agentic`).
   Agentic search is scoped to an identity or a tenant, as the API defines it
   ([REST API › Search](../../reference/api.md#search)): `--tenant` sends the same body to
   `POST /v1/tenants/{t}/search`, which needs a tenant or platform key with the same two permissions and
   covers up to 100 identities (`422 scope_too_large`, exit 7, above that); an identity key gets
   `403 scope_denied` (exit 4). `search --mode agentic --tenant` is the same call without a stream.
2. `sse.rs` reads events as defined in [Search §11.11](search.md#1111-streaming): lines `id:`,
   `event:`, `data:`; a blank line ends an event; lines starting with `:` (keep-alive) are ignored.
   `data` is parsed as JSON.
3. Rendering (human mode, terminal):

```text
⋯ step 1  search "claim Golf photos" (hybrid) · 7 hits · 412 ms
⋯ step 2  read thread thr_01JA… · 38 ms

Yes. Admiral accepted claim 7781 on 2 October, after the photos sent on 28 September [1][2].

[1] msg_01JA…  2026-10-02  Admiral Claims <claims@admiral.example>  "Claim 7781 – decision"
[2] msg_01JB…  2026-09-28  Acme Car Hire <compliance@acme.example.com>  "Photos for claim 7781"

answered · confidence 0.86 · 3 steps · 2.8 s
```

   - `step` events print as dim progress lines on stderr (only when stderr is a terminal, or with
     `--show-trace`). `evidence` events update a counter.
   - The answer is printed from the `done` event, which carries the complete response; citations
     (`[msg_…]` markers in `answer.text`, and `sentences[].citations`) are renumbered `[1]`, `[2]` in
     order of first use and listed with date, sender and subject from `evidence`. Every string goes
     through `terminal_safe` ([§3.2](#32-untrusted-text-in-a-terminal)).
   - `insufficient_evidence` prints "Not enough evidence to answer." and the top evidence;
     `budget_exhausted` prints the partial answer (if any) marked partial; `degraded` prints the hybrid
     results as a search would. All four statuses exit 0; the status is in the last line and in JSON.
   - A `done` event with an `error` object prints the error as in [§3.3](#33-errors) and exits by its
     code.
4. `--json` prints only the `done` event's data (the same body as the non-streaming call).
   `--json --stream` prints each event as one JSON line `{ "event": "step", "id": 2, "data": {…} }`
   (NDJSON) as it arrives.
5. `--no-stream` sends `stream: false` and renders the response the same way.
6. Ctrl-C closes the connection (the server stops at its next state transition) and exits 130.

## 18. Other client-side behaviour

- **`search`** prints a table: date, direction, sender, subject, score and `why` (first two entries);
  with `--group-by thread` one row per thread. `degraded: true` and `semantic_coverage` below 0.98 are
  shown as a warning line. `--tenant` uses `POST /v1/tenants/{id}/search`; hits then show the identity.
  `--cursor <cursor>` passes a cursor (the `next_cursor` of the previous page).
- **`wait`** prints the message (or `timed out`), and for `--kind verification` the code and link on
  their own lines so a script can read them with `--quiet`. `timed_out: true` is exit 13.
- **`send`, `reply`, `reply-all`, `forward`**: `--text-file` and `--html-file` read bodies;
  `--attach <path>` (repeatable) reads files, guesses the content type from the extension
  (`application/octet-stream` otherwise) and base64-encodes them; the CLI refuses before sending when
  the encoded total exceeds 5 MiB unless `--allow-large` (the tenant may have
  `large_attachments: "link"`). Recipients take `Name <addr>` or `addr`.
- **`keys create` and `webhooks create`** print the secret once. In human mode it is on its own line
  after the object, with "shown only once"; `--quiet` prints only the secret.
- **`messages raw` and `messages attachment`** write bytes to `--out <file>` (created with mode `0600`)
  or to stdout only when stdout is not a terminal; to a terminal they refuse, so binary or hostile
  bytes never reach it.
- **`usage`** prints the allowances table from `GET /v1/usage` (feature, granted, used, remaining,
  resets). A tenant or identity key reads its own workspace and needs no permission (it holds
  `usage:read` for its own workspace implicitly); a platform key needs `usage:read` and a tenant from
  `--tenant` or the profile's `tenant`, never the default tenant ([§2.4](#24-resolving-names-to-ids)):
  without one the API answers `400 invalid_request` (exit 7). **`usage daily`** prints one row per day
  from `GET /v1/usage/daily` (`--from`, `--to`, at most 92 days apart; `usage:read`, platform or tenant
  key, with the same tenant rule), including the `assertions` and `http_signatures` counts.
- **`plans list`** calls `GET /v1/plans` without an `Authorization` header, so it works with no key;
  on a deployment without billing it prints "billing is off". **`billing get|set`** read and change a
  workspace's billing account (`GET|PATCH /v1/tenants/{t}/billing`, platform key with
  `tenants:manage`); `billing set` sends only the flags given (`--mode`, `--plan`), and
  `409 plan_managed_by_stripe` is exit 6.
- **`members list`** prints members, pending invitations and seats from one call. `members invite`
  sends `{ "email", "role" }` (`--role` defaults to `member`); with no seat left the API answers
  `402 billing_limit` (`seats`), exit 8. `members remove` and `invitations revoke` take an ID
  (`usr_…`, `inv_…`) or an email address, resolved through `members list`, and ask for confirmation
  unless `--yes`. Removing the owner is `409 owner_required`, exit 6.
- **`jobs start reparse|reembed|reindex`** sends `{ "kind", "tenant_id", "identity_ids", "after",
  "before" }`. `--tenant` is required, and neither the profile's `tenant` nor the default tenant
  replaces it (a job over the wrong tenant is costly to undo); each repeated `--identity` is resolved to an ID ([§2.4](#24-resolving-names-to-ids));
  without `--identity`, `identity_ids` is `null` (every identity of the tenant). It prints the job;
  `jobs get <job_id>` prints its status and, once it ends, `result`.
- **`waitlist invite --count N [--plan P]`** checks `N` is 1–500 before sending (exit 2 otherwise) and
  prints `Invited 50; 262 still waiting.` from `{ "invited", "waiting" }`
  ([Cloud sign-up §6.1](cloud-signup.md#61-before-launch-the-waitlist)).
- **`keys create`** needs `--permissions` at every level (least privilege is the default, not an
  option). A platform key has no implicit full set: `--level platform` without `--permissions` is exit 2
  before any request, with a message listing the permissions a platform key may hold (the API would
  answer `400 invalid_request`). The API also refuses, with `400 invalid_request` and
  `details.reason = "permission_not_allowed_for_level"` (exit 7), a permission the level cannot hold:
  `identities:sign` on a platform key; `tenants:manage` and `platform:ops` below platform level; and
  the tenant-only `members:read`, `members:manage`, `suppressions:manage`, `audit:read` and `usage:read`
  on an identity key. `--save-profile <name>` writes the new key into that profile.
- **Notification preferences** have no command: they belong to people, not keys, and are set only in the
  console ([Notifications §2](notifications.md#2-preferences)).

### 18.1 `domains add` without `PM_CF_API_TOKEN`

[Configuration](../../reference/configuration.md#secrets) and [Errors](../../reference/errors.md)
(`cf_token_required`) say that a deployment without `PM_CF_API_TOKEN` can still add a `cloudflare_zone`
apex with `pmail domains add`, using the operator's local token. The API has no request field for
registering a domain that a client has already onboarded, so the CLI does it itself, and only when asked
with `--local-token`.

**Without `--local-token`** (the default), `domains add` is a plain API call ([§18.2](#182-domains-add---method)),
and the CLI checks nothing locally: the API decides. It maps the two refusals that mean "this deployment
is not set up for the method" to exit 3 (`config`) instead of the API's exit 7:

- `422 transport_unavailable`: the deployment or the tenant's policy lacks what the method needs. The
  CLI prints `details.reason` with its fix (`ses_not_configured` and `ses_receiving_not_configured`:
  `pmail setup ses`; `subdomain_setup_disabled`: `PM_CF_SUBDOMAIN_SETUP = "on"`;
  `zone_creation_not_allowed`: the tenant policy `domains.allow_create_zone`; `ses_identity_limit`:
  raise the SES limit; `method_not_supported`: another method; `marketing_needs_ses`: send marketing from a
  domain with the `ses` or `smtp` transport).
- `422 cf_token_required`: the deployment has no `PM_CF_API_TOKEN`. The fix is "set `PM_CF_API_TOKEN` on
  the deployment (`wrangler secret put PM_CF_API_TOKEN`), or, for a zone apex, run again with
  `--local-token`".

The CLI never falls back to the local token on its own.

**With `--local-token`:**

1. **Prerequisites, checked locally before any request.** `--method cloudflare_zone` (any other method
   is exit 2: `nameservers` and `delegated_subdomain` need zones that the Worker must create and watch);
   `CLOUDFLARE_API_TOKEN` and the account ID of [§2.5](#25-cloudflare-credentials) (exit 3); the domain
   is a zone **apex** in that account, found as in setup's preflight step 4 (a subdomain is exit 2 with
   the fix "set `PM_CF_API_TOKEN` on the deployment": its literal routing rules are created per address
   over the domain's life, including retries and retirements, which a one-off CLI run cannot own).
2. Call `POST /v1/tenants/{t}/domains` as usual, so the key's permission (`domains:write`), the tenant
   and the domain name are checked by the API. If the deployment does have `PM_CF_API_TOKEN`, the Worker
   onboards the domain and the result is printed as usual; the local token is not used. Anything other
   than `422 cf_token_required` is handled as usual.
3. On `cf_token_required`: run steps 1–8 of
   [Identities, addresses and domains › Kind `zone`](identity-domains.md#kind-zone) with the local token
   (including the existing-MX and SPF preflights, with `--replace-mx` as the explicit opt-in).
4. Insert the row through the D1 query API (`POST /accounts/{a}/d1/database/{id}/query`), with the
   account ID of step 1: the database is the one named `pylota-mail` in that account, found by name as
   in setup step 2, or the `database_id` of `<dir>/wrangler.toml` when that file exists. The statement
   is the one of [§6.6](#66-the-platform-domain-row) with `tenant_id`, `kind = 'zone'`,
   `method = 'cloudflare_zone'`, `inbound = 'routing'` and `state = 'pending'`. The Worker's cron hook
   mints the monitor, starts verification and emits `domain.created`. An apex uses the catch-all, so no
   literal rules are needed.
5. Steps the Cloudflare API cannot do (spike S9) are printed as dashboard steps, and `doctor` checks
   them.

A Cloudflare API or D1 failure in steps 3 and 4 is exit 10; every step reads first, so a re-run continues.

### 18.2 `domains add --method`

`pmail domains add <name> --method <method> [flags]` builds the create body of
[Domains on any DNS host §8](domain-connections.md#8-api) from its flags and calls
`POST /v1/tenants/{t}/domains` (`domains:write`). `--method` is required; the CLI never sends the old
`kind` spelling.

| Flag | Body field | Allowed with |
|---|---|---|
| `--method` | `method` | always: `cloudflare_zone`, `nameservers`, `dns_records`, `send_only`, `smtp_relay`, `delegated_subdomain` |
| `--no-receiving`, `--no-sending` | `receiving: false`, `sending: false` | always |
| `--replace-mx` | `replace_mx: true` | `cloudflare_zone` (apex), `dns_records` |
| `--confirm-dedicated` | `confirm_dedicated: true` | `nameservers` |
| `--inbound forward\|ses` | `inbound` | `smtp_relay` (required) |
| `--smtp-host`, `--smtp-port 465\|587`, `--smtp-username` | `smtp.host`, `smtp.port`, `smtp.username` | `smtp_relay` (required) |
| `--smtp-password-stdin` | `smtp.password` | `smtp_relay` (required) |
| `--probe-from` | `smtp.probe_from` | `smtp_relay` (optional; the API defaults it to `postmaster@{domain}`) |
| `--local-token` | none (a CLI behaviour, [§18.1](#181-domains-add-without-pm_cf_api_token)) | `cloudflare_zone` (apex) |

- A flag that the chosen method does not allow, or a missing required one, is exit 2 before any
  request. `--smtp-port` other than 465 or 587 is exit 2 too (the API would answer
  `400 smtp_port_not_allowed`).
- **The SMTP password is never accepted on the command line, from the environment or from the config
  file.** `--smtp-password-stdin` reads it from stdin up to the first newline (removed); when stdin is a
  terminal the CLI asks with hidden input. The value is held in memory for the one request and is never
  printed, logged or included in an error document.
- **Output.** The domain in `pending`, then its records as a table with both `name` (fully qualified)
  and `host` (relative to the registrable domain), so the user can enter whichever their DNS host wants
  ([N17](../edge-cases.md)); columns type, name, host, value, priority, purpose, required. For
  `nameservers` and `delegated_subdomain` the records are the `NS` values to set at the registrar or
  DNS host. `--json` prints the response unchanged.
- Errors keep their API meaning: `409 domain_not_dedicated` (exit 6) prints `details.records` and the
  fix `--confirm-dedicated`; `429 upstream_rate_limited` (exit 8) prints the retry time.
  `422 transport_unavailable` and `422 cf_token_required` are the two exceptions to the API's exit code:
  exit 3, with the fixes listed in [§18.1](#181-domains-add-without-pm_cf_api_token).

### 18.3 `domains update`, `domains probe` and `addresses test-forwarding`

- **`domains update <domain>`** sends `PATCH /v1/domains/{domain_id}` (`domains:write`). `--transport
  cloudflare|ses` sets `transport`, which only a platform key may change (`403 scope_denied`, exit 4,
  for others). The `--smtp-host`, `--smtp-port`, `--smtp-username`, `--smtp-password-stdin` and
  `--probe-from` flags send a complete `smtp` object, as on domain create: the CLI reads the domain
  first and fills `host`, `port`, `username` and `probe_from` that were not given from its current
  `smtp`. The API never returns the password, so `--smtp-password-stdin` is required with any `--smtp-…`
  or `--probe-from` change (exit 2 otherwise), with the stdin rule of §18.2. The API keeps new `smtp`
  values pending until a probe passes and answers `200` with the domain; the CLI prints it and says the
  probe is running.
- **`domains probe <domain>`** sends `POST /v1/domains/{domain_id}/probe` (`domains:write`) and prints
  the `probe_id` from the `202`. The result arrives as a domain health change, so the CLI points to
  `pmail domains health <domain>`. More than one probe a minute is `429 rate_limited` (exit 8).
- **`addresses test-forwarding <address>`** sends
  `POST /v1/identities/{identity_id}/addresses/{address_id}/test-forwarding` (`identities:write`). The
  argument is an address ID (with `--identity`) or the address itself, resolved through
  `GET /v1/identities/lookup` and the identity's address list. It prints that the test was sent; the
  result appears within 10 minutes as the address's `forwarding` (`ok` or `failed`) in
  `pmail addresses list`. A domain without `inbound: forward` gives `422 transport_unavailable`
  (`method_not_supported`), exit 7.

### 18.4 `domains subscribe`

`pmail domains subscribe <domain> [--tenant <tenant>]` exists for the spike S9 fallback
([Identities, addresses and domains › Kind `zone`](identity-domains.md#kind-zone)): a Cloudflare-transport
domain created without an Email Sending event subscription reports `delivery_events: "manual"` and
`details.action = "run pmail domains subscribe <domain>"`. Delivery events for that domain start once this
command has run.

1. `GET /v1/domains/{domain_id}` (resolved by name as in [§2.4](#24-resolving-names-to-ids)). Anything
   other than `transport = "cloudflare"`, `sending = true` and `delivery_events = "manual"` prints the
   current value and exits 0 without changes (a re-run is a no-op).
2. With the operator's local `CLOUDFLARE_API_TOKEN` (exit 3 without it): find the zone ID by name
   (`GET /zones?name=`), then run `wrangler queues subscription create pm-delivery-events --source
   email.sending --zone-id <zone_id> --domain <domain>` (the flags read from the Wrangler 4 command
   reference on 2026-10-09). Before creating, list the subscriptions
   (`GET /accounts/{a}/event_subscriptions/subscriptions`) and reuse one that already targets this zone
   and domain, so an interrupted run never makes two.
3. Record the ID through the D1 query API, with the account ID and database found as in
   [§18.1](#181-domains-add-without-pm_cf_api_token) step 4:
   `UPDATE domains SET event_subscription_id = ?1 WHERE id = ?2 AND event_subscription_id IS NULL`.
   The domain then reports `delivery_events: "active"`.
4. Print the domain. `--json` prints it unchanged. Wrangler or Cloudflare API failures are exit 10.

`pmail doctor` (`sending.event_subscriptions`) fails for every `manual` domain, with this command as the
fix.

### 18.5 `identity-keys`, `assertions` and `http-sign`

The client side of [Agent signing keys](agent-keys.md#7-api-mcp-and-cli). Every command except
`assertions verify` takes `--identity` (resolved as in [§2.4](#24-resolving-names-to-ids)); an identity
key uses its own identity.
Key management works while the identity is paused ([Agent signing keys §2](agent-keys.md#2-keys)); a
`deleting` or `deleted` identity is `404 identity_not_found` (exit 5). No private key ever reaches the CLI.

**`identity-keys`** (`identities:read` to list, `identities:write` for the rest; platform, tenant or
identity key):

- `pmail identity-keys list --identity <identity> [--status active|retiring|retired] [--limit <n>] [--all]`
  calls `GET /v1/identities/{id}/keys`. Human mode prints a table of kid, status, `created_at`,
  `verify_until` and `retired_at`, newest first, `retired` keys included. The public JWKs are in the JSON
  output only.
- `pmail identity-keys create --identity <identity>` calls `POST /v1/identities/{id}/keys` with `{}`.
  `201` prints `Created key <kid>`; `200` prints `Active key <kid> already exists` and changes nothing.
  Both exit 0. Keys are also created on the first signing request, so this command is optional.
- `pmail identity-keys rotate --identity <identity>` calls `POST …/keys/rotate` and prints the new kid
  and, when there was one, the previous kid with its `verify_until`. It asks no confirmation: the
  previous key keeps verifying through the overlap (`PM_IDENTITY_KEY_OVERLAP_DAYS`, default 7 days).
- `pmail identity-keys revoke <kid> --identity <identity> [--yes]` calls `POST …/keys/{kid}/revoke`.
  Interactive runs ask first, saying that assertions signed with that key stop verifying at once, as
  soon as verifiers fetch the JWKS again (it is cached for up to 5 minutes); non-interactive runs need
  `--yes` (exit 2 otherwise). An unknown kid is `404 key_not_found` (exit 5); a key already `retired`
  prints `already retired` and exits 0.

**`assertions create`** (`identities:sign`, tenant or identity key; a platform key cannot hold the
permission and is refused with `403`, exit 4):

`pmail assertions create --identity <identity> --audience <aud> [--expires-in <60-600>] [--nonce <nonce>] [--ext <json> | --ext-file <file>]`

- Sends `POST /v1/identities/{id}/assertions` with `audience`, `expires_in` (default 300), `nonce` and
  `ext`. `--ext` must parse as a JSON object (exit 2 otherwise); the size and claim-name rules are the
  API's (`400 invalid_request`, exit 7). No `Idempotency-Key` is sent ([§4](#4-http-behaviour-against-the-api)).
- Output: the response as indented JSON (`assertion`, `kid`, `expires_at`, `jwks_uri`); `--quiet` prints
  only the token, for `$(…)` in a script. The token is a short-lived credential for its audience: the
  CLI never writes it to a file or a log.
- Suspended tenant → `403 tenant_suspended` (exit 4); paused identity → `409 identity_paused` (exit 6).

**`assertions verify`** (no API key and no Cloudflare credentials):

`pmail assertions verify <token> --audience <aud> [--issuer <url>] [--now <unix-seconds>]`

Checks an assertion offline, the way a verifier should, by calling the SDK's `verify_assertion`
([Rust workspace §11](rust-workspace.md#11-the-rust-sdk-fr-sdk-1)), which follows
[Agent signing keys §4.3](agent-keys.md#43-how-a-verifier-checks-it):

1. The token comes from the argument, or from stdin when it is `-` (a token on the command line is
   visible in the process list, as in [§2.2](#22-precedence)).
2. `--audience` is required (exit 2 without it). `--issuer` defaults to the resolved API URL
   (`--url`, `PYLOTA_MAIL_URL` or the profile's `url`); with none of them, exit 3. It must be `https://`
   except for `localhost`, `127.0.0.1` and `[::1]` (exit 2 otherwise).
3. The header must have `alg: EdDSA` and `typ: agent-assertion+jwt`; `iss` must equal the issuer.
   Only then is `{iss}/.well-known/jwks/{sub}.json` fetched, without an `Authorization` header and
   after checking that `sub` is a well-formed identity ID. A key URL inside the token is never used.
4. The key whose `kid` matches verifies the Ed25519 signature; `aud` must equal `--audience`; `nbf` and
   `exp` are checked against `--now` or the clock, allowing 60 seconds of skew.
5. Replay (step 6 of §4.3) needs state across calls, so the CLI does not check it; it prints `jti` and
   `exp` for a caller that keeps a replay cache.

Output: `valid` and the claims (`sub`, `email`, `name`, `org`, `aud`, `exp`, `jti`, `kid`), exit 0; or
`invalid: <reason>`, exit 11 (`verification`, [§3.4](#34-exit-codes)), where reason is `malformed`,
`unsupported_algorithm`, `issuer_mismatch`, `identity_not_found` (the JWKS answered `404`: the identity is
unknown, paused, suspended or deleted), `unknown_kid`, `bad_signature`, `audience_mismatch`, `expired` or
`not_yet_valid`. A JWKS fetch that fails for another reason (network, TLS, `5xx`) is exit 9, not a
verdict. JSON: `{ "valid": true, "kid", "claims": { … } }` or `{ "valid": false, "reason" }`.

**`http-sign`** (`identities:sign`, tenant or identity key):

`pmail http-sign --identity <identity> --url <https-url> [--method <METHOD>] [--expires-in <30-300>] [--component @method|@path|@query]…`

- Sends `POST /v1/identities/{id}/http-signatures` with `url`, `method`, `expires_in` (default 60) and,
  when `--component` is given, `components`: `@authority`, `signature-agent` and `from` (always signed)
  plus the repeated `--component` values. `--method` is signed only with `--component @method`, as the
  API defines it. Other component names are exit 2 before the request. No `Idempotency-Key` is sent.
- Human and quiet modes print the four headers as `Name: value` lines, in the order `Signature-Agent`,
  `From`, `Signature-Input`, `Signature`, ready for `curl -H @file`; `--json` prints the response
  unchanged (`headers`, `expires_at`). The signature expires after `--expires-in` seconds, so it is made
  right before the request it signs.
- Errors keep their API meaning: `403 tenant_suspended` (exit 4), checked first, for an identity of a
  suspended tenant; `422 web_bot_auth_disabled` (exit 7) while `PM_WEB_BOT_AUTH` is `off`;
  `403 policy_denied` (exit 4) while the tenant policy `web_bot_auth.allowed` is `false`;
  `400 invalid_request` (exit 7) for a URL that is not `https`, an expiry outside 30–300 s or a non-ASCII
  component value; `409 identity_paused` (exit 6).

Signing by both commands shares the `RL_SIGN` limit of 600 calls a minute per identity; over it the API
answers `429 rate_limited` (exit 8, after the retries of [§4](#4-http-behaviour-against-the-api)).

## 19. Command-to-endpoint map

This is the command tree: every `pmail` command and what it calls. A command needs the permission of
its endpoint ([REST API](../../reference/api.md#permissions)); the rows for platform operations,
members, billing, the newer domain commands and the signing commands name it. Notification preferences
have no command: they are set only in the console ([Notifications §2](notifications.md#2-preferences)).

| Command | Endpoint(s) |
|---|---|
| `tenants create\|list\|get\|update` | `POST /v1/tenants`; `GET /v1/tenants`; `GET /v1/tenants/{id}`; `PATCH /v1/tenants/{id}` |
| `tenants suspend\|resume` | `PATCH /v1/tenants/{id}` `{"status":"suspended"\|"active"}` |
| `identities create\|list\|get\|update` | `POST /v1/tenants/{t}/identities`; `GET /v1/tenants/{t}/identities` or `GET /v1/identities`; `GET /v1/identities/{id}`; `PATCH /v1/identities/{id}` |
| `identities pause\|resume` | `PATCH /v1/identities/{id}` `{"status":"paused"\|"active"}` |
| `identities delete` | `DELETE /v1/identities/{id}` (typed confirmation of the address) |
| `identities lookup` | `GET /v1/identities/lookup?address=` |
| `addresses list\|add\|promote\|retire\|delete` | `GET\|POST /v1/identities/{id}/addresses`; `POST …/{adr}/promote`; `POST …/{adr}/retire`; `DELETE …/{adr}` |
| `addresses test-forwarding` | `POST /v1/identities/{id}/addresses/{adr}/test-forwarding` (`identities:write`; [§18.3](#183-domains-update-domains-probe-and-addresses-test-forwarding)) |
| `domains add\|list\|get\|records\|verify\|health\|reprove\|remove` | `POST /v1/tenants/{t}/domains` ([§18.2](#182-domains-add---method)); `GET /v1/tenants/{t}/domains`; `GET /v1/domains/{id}`; `GET …/records`; `POST …/verify`; `GET …/health`; `POST …/reprove`; `DELETE /v1/domains/{id}` |
| `domains update` | `PATCH /v1/domains/{id}` (`domains:write`; `--transport` needs a platform key) |
| `domains probe` | `POST /v1/domains/{id}/probe` (`domains:write`) |
| `domains add --local-token` | `POST /v1/tenants/{t}/domains`; on `422 cf_token_required`, the Cloudflare API and the D1 query API with the local token ([§18.1](#181-domains-add-without-pm_cf_api_token)) |
| `domains subscribe` | `GET /v1/domains/{id}`; then the Cloudflare API, Wrangler and the D1 query API with the local token ([§18.4](#184-domains-subscribe)) |
| `send`, `reply`, `reply-all`, `forward` | `POST /v1/identities/{id}/messages`; `POST …/messages/{m}/reply`; `…/reply-all`; `…/forward` |
| `cancel`, `resolve` | `POST …/messages/{m}/cancel`; `POST …/messages/{m}/resolve` |
| `threads list\|get\|label\|hold\|unhold` | `GET /v1/identities/{id}/threads`; `GET …/threads/{t}`; `PATCH …/threads/{t}`; `POST …/threads/{t}/hold`; `DELETE …/threads/{t}/hold` |
| `messages list\|get\|raw\|attachment\|attachment-text\|label` | `GET …/messages`; `GET …/messages/{m}`; `GET …/raw`; `GET …/attachments/{a}`; `GET …/attachments/{a}/text`; `PATCH …/messages/{m}` |
| `search` | `POST /v1/identities/{id}/search` or `POST /v1/tenants/{t}/search` |
| `ask` | `POST /v1/identities/{id}/search` or, with `--tenant`, `POST /v1/tenants/{t}/search` (`mode: agentic`, streamed; `search:read` and `search:agentic`; [§17](#17-ask)) |
| `triage list\|rerun` | `GET /v1/identities/{id}/threads?category=&needs_reply_gte=` (threads with their roll-up); `POST …/messages/{m}/triage` |
| `wait` | `GET /v1/identities/{id}/wait` |
| `quarantine list\|release` | `GET /v1/identities/{id}/quarantine`; `POST …/messages/{m}/release` |
| `webhooks create\|list\|get\|update\|delete\|rotate\|test\|deliveries\|replay` | `POST /v1/webhooks` or `POST /v1/tenants/{t}/webhooks`; `GET` (both); `GET\|PATCH\|DELETE /v1/webhooks/{w}`; `POST …/rotate-secret`; `POST …/test`; `GET …/deliveries`; `POST …/replay` |
| `webhooks verify` | none (offline, [§16](#16-webhooks-verify)) |
| `keys create\|list\|get\|revoke` | `POST /v1/keys`; `GET /v1/keys`; `GET /v1/keys/{k}`; `DELETE /v1/keys/{k}` |
| `keys rotate key_…` | `POST /v1/keys/{k}/rotate` (`keys:manage`) |
| `keys rotate thread\|link\|cursor\|web_bot_auth` | `POST /v1/platform/keys/{purpose}/rotate`, `?revoke_previous=true` with `--revoke-previous` (platform key, `platform:ops`; [§12.2](#122-signing-keys-keys-rotate-threadlinkcursorweb_bot_auth)) |
| `identity-keys list` | `GET /v1/identities/{id}/keys` (`identities:read`; [§18.5](#185-identity-keys-assertions-and-http-sign)) |
| `identity-keys create` | `POST /v1/identities/{id}/keys` (`identities:write`) |
| `identity-keys rotate` | `POST /v1/identities/{id}/keys/rotate` (`identities:write`) |
| `identity-keys revoke` | `POST /v1/identities/{id}/keys/{kid}/revoke` (`identities:write`) |
| `assertions create` | `POST /v1/identities/{id}/assertions` (`identities:sign`, tenant or identity key) |
| `assertions verify` | none with a key: `GET {iss}/.well-known/jwks/{sub}.json`, unauthenticated, through the SDK's `verify_assertion` ([§18.5](#185-identity-keys-assertions-and-http-sign)) |
| `http-sign` | `POST /v1/identities/{id}/http-signatures` (`identities:sign`, tenant or identity key) |
| `suppressions list\|add\|remove` | `GET\|POST /v1/tenants/{t}/suppressions`; `DELETE /v1/tenants/{t}/suppressions/{address}` |
| `lists list\|add\|remove` | `GET /v1/tenants/{t}/lists/{direction}/{kind}`; `PUT …/{entry}`; `DELETE …/{entry}` |
| `erasure create\|get\|list` | `POST /v1/erasure-requests`; `GET /v1/erasure-requests/{id}`; `GET /v1/erasure-requests` |
| `export create\|get` | `POST /v1/exports`; `GET /v1/exports/{id}` |
| `members list\|invite\|remove` | `GET /v1/tenants/{t}/members` (`members:read`); `POST /v1/tenants/{t}/invitations`; `DELETE /v1/tenants/{t}/members/{user_id}` (`members:manage`, tenant or platform key) |
| `invitations revoke` | `DELETE /v1/tenants/{t}/invitations/{invitation_id}` (`members:manage`) |
| `plans list` | `GET /v1/plans` (no key) |
| `billing get\|set` | `GET\|PATCH /v1/tenants/{t}/billing` (platform key, `tenants:manage`) |
| `usage` | `GET /v1/usage` (tenant and identity keys: their own workspace, no permission needed; platform keys: `usage:read` and `tenant_id` from `--tenant` or the profile, else `400 invalid_request`) |
| `usage daily` | `GET /v1/usage/daily` (`usage:read`, platform or tenant key; a platform key passes `tenant_id` as for `usage`) |
| `audit` | `GET /v1/audit-events` |
| `dlq list\|redrive` | `GET /v1/platform/dlq`; `POST /v1/platform/dlq/{dlq_id}/redrive` (platform key, `platform:ops`; [§13](#13-dlq)) |
| `jobs start\|get` | `POST /v1/platform/jobs`; `GET /v1/platform/jobs/{job_id}` (platform key, `platform:ops`) |
| `waitlist invite` | `POST /v1/platform/waitlist/invite` (platform key, `platform:ops`) |
| `mcp config` | `GET /v1/me` |
| `login`, `config show\|set` | `GET /v1/me` (`config set`: none) |
| `setup`, `deploy`, `upgrade`, `doctor`, `destroy`, `secrets rotate-master` | Cloudflare API, Wrangler, GitHub, and the API as described above (`doctor` also reads `/.well-known/*`; `destroy --include-ses` also the AWS APIs) |
| `setup ses` | AWS APIs, Wrangler, the Cloudflare API and `/health` ([§6.9](#69-setup-ses)) |

## Tests

| Test | Proves | Covers |
|---|---|---|
| `cli::config::precedence` | Flag over environment over profile for URL, key, profile and defaults | FR-CLI-1 |
| `cli::config::insecure_file_refused` | A group- or world-readable file, or one owned by another user, is refused with exit 3; writes are atomic with mode `0600` | FR-CLI-1 |
| `cli::config::key_sources` | `key`, `key_env`, `key_command` (timeout, non-zero exit, bad output) and the one-source rule | FR-CLI-1 |
| `cli::config::profile_written` | `setup` and `login` write the profile named by `--profile`, else `default`, whatever `PYLOTA_MAIL_PROFILE` and `default_profile` say; setup stores `account_id` and never the token; `login` warns when `PYLOTA_MAIL_KEY` differs from the saved key | FR-CLI-1 |
| `cli::output::json_every_command` | Every command in the tree prints exactly one JSON document with `--json`, including errors, and nothing else on stdout; `ask --json --stream` prints NDJSON, one document per line | FR-CLI-1 |
| `cli::output::terminal_safe` | ANSI escapes, C1 controls, bidi and zero-width characters from mail are neutralised in human output | FR-CLI-1, [E1] |
| `cli::output::exit_codes` | Each HTTP status and CLI error maps to the code in §3.4; a `404` without envelope is exit 9 | FR-CLI-1 |
| `cli::http::send_idempotency_reuse` | A send retried after a network error reuses the same key; a generated key is printed | FR-OUT-1 |
| `cli::setup::idempotent_rerun` | Two runs against the recorded Cloudflare fake create every resource once; the second run reports `exists` for all | FR-OPS-1 (M16) |
| `cli::setup::resume_after_failure` | A run failing at each step in turn, then re-run, ends in the same state as a clean run | FR-OPS-1 |
| `cli::setup::order` | The recorded call order matches §6.3; the catch-all `PUT` comes after the first deploy, the secrets and a `200` health | FR-OPS-1 |
| `cli::setup::h5_existing_mx` | Foreign MX records stop setup without `--replace-mx`; with it they are deleted before routing is enabled | [H5] |
| `cli::setup::not_apex` | A subdomain or a zone in another account is refused with the zone's name | FR-OPS-1 |
| `cli::setup::lifecycle_merge` | Existing R2 lifecycle rules are kept; the staging rule is added or replaced | FR-OPS-1 |
| `cli::setup::bootstrap_key` | The inserted key authenticates against the workerd harness and holds every permission except `identities:sign`; the decision table of §6.5 holds, including refusal when keys exist, and every pepper upload happens in step 14 | FR-OPS-1, FR-KEY-2 |
| `cli::setup::owner_email` | The default tenant is created with the owner; `--no-console` writes `PM_CONSOLE = "off"` | FR-CON-7 |
| `cli::setup::billing_off` | Setup writes no `PM_BILLING`; the default tenant reports `billing: disabled` | FR-BILL-12 |
| `cli::setup::secrets_never_written` | Generated secrets reach Wrangler only on stdin and appear in no file, argument or log unless `--print-secrets` | FR-OPS-1, [I5] |
| `cli::setup::renders_optional_settings` | The rendered file has the `Q_DELIVERY` producer, the `NOTIFY` Durable Object binding (class `Notifier`), six rate-limit bindings including `RL_SIGNIN` and `RL_SIGN` (an older file gets an ID for each missing one), `PM_WEB_BOT_AUTH = "off"`, `PM_IDENTITY_KEY_OVERLAP_DAYS` and `PM_NOTIFICATIONS`, `PM_CONSOLE_HOST` (the API host, or `--console-host` with a second Custom Domain) and `PM_SIGNUP = "closed"`; `--daily-send-quota` writes `PM_DAILY_SEND_QUOTA`; `--backup-bucket` creates the bucket in the jurisdiction and binds it as `BACKUP` | FR-OPS-1, FR-CON-8 |
| `cli::setup::ses_idempotent_rerun` | Against a recorded AWS fake, every resource of §6.9 is created once and a second run reports `exists` for all and deploys nothing; an existing active rule set is never deactivated; both SNS topics end with `SignatureVersion = 2`; the HTTPS subscriptions come after the deploy | FR-DOM-8, FR-DOM-9 |
| `cli::setup::ses_region_check` | A region that cannot receive is exit 2; a region outside the EU and the UK under `PM_JURISDICTION = "eu"` is exit 2 without `--allow-non-eu` and accepted with it, and `eu-west-2` (London) is accepted without it; no production access is exit 14 with the console steps and nothing created; Essentials prints a warning | FR-DOM-8, [N30] |
| `cli::setup::ses_policy_and_key` | The IAM policy JSON is printed before it is applied and needs a confirmation or `--yes`; the access key reaches Wrangler only on stdin, appears in no file, argument, output or log, and is not created again when `PM_SES_ACCESS_KEY_ID` exists | FR-DOM-8, [I5] |
| `cli::render::preserves_vars` | Operator edits under `[vars]` and in `[observability.traces]` survive a re-render; owned sections (including `[observability]` and `[observability.logs]`) are restored with a diff | FR-OPS-2 |
| `cli::deploy::tampered_bundle_refused` | A modified tarball, `SHA256SUMS`, signature, wrong key ID or replayed trusted comment is exit 11 and nothing is deployed | FR-OPS-2 (M16) |
| `cli::deploy::safe_extraction` | Symlinks, `..`, absolute paths and oversized archives are refused | FR-OPS-2 |
| `cli::deploy::migrations_before_code` | Migrations run before Wrangler; a failing migration stops the deploy; `schema_migrations` is updated | FR-OPS-2, [J9] |
| `cli::deploy::gradual_abort` | A failing health check or new alert at a stage rolls back to the old version at 100% | FR-OPS-2 |
| `cli::deploy::do_migration_forces_full_deploy` | A changed `[[migrations]]` tag uses `wrangler deploy`, not `versions upload` | FR-OPS-2, [J9] |
| `cli::deploy::index_generation` | Start, in-progress, finalise and cancel render the bindings Search §7.3 requires | FR-SRCH-2 |
| `cli::deploy::noop_redeploy` | `deploy` straight after `setup` calls no Wrangler command and exits 0 | FR-OPS-2 |
| `cli::deploy::version_flag` | `pmail deploy --version <v>` downloads and deploys that release | M19 |
| `cli::doctor::every_check_has_fix` | Each failing check prints a fix; exit 12 with a fail, 0 with warnings only | FR-OPS-3 (M16) |
| `cli::doctor::warn_rules` | `secrets` warns only while `PM_MASTER_KEY_NEXT` exists; `quota` warns when `PM_DAILY_SEND_QUOTA` is unset, and when the token lacks Account Analytics · Read (never `fail` for that); `cloudflare.zones` prints the count and warns above 1,000; a Cloudflare error in any other check is `fail` and exit 12, never 10 | FR-OPS-3 |
| `cli::doctor::web_bot_auth` | `skip` with `PM_WEB_BOT_AUTH = "off"`; with `on`, `pass` for a directory signed once per listed key, `fail` for a missing signature, a wrong tag or content type, or more than three keys | FR-OPS-3, FR-IDN-8, [O12] |
| `cli::doctor::ses_check` | `skip` without `PM_SES_REGION` or AWS credentials; `fail` on no production access, paused sending, an inactive rule set or a missing `pm-deliver`; `warn` `ses_identities_90pct` at 9,000 identities and `fail` at 10,000 | FR-OPS-3, FR-DOM-9, [N26] |
| `cli::destroy::confirmation` | Without the typed platform domain nothing is deleted; `--dry-run` changes nothing; an erasure ending `completed_with_holds` lists the held threads and exits 6 before any domain, Worker or storage is deleted | FR-OPS-1, FR-PRV-4 |
| `cli::destroy::include_ses` | Without `--include-ses`, the plan and the final output list the `setup ses` resources as left in place and no AWS call is made; with it and no AWS credentials, exit 3 before anything is deleted; with credentials, every resource of §6.9 is deleted in reverse order against the recorded AWS fake, an operator's own active rule set is kept without `pm-deliver`, and a re-run after a failure continues | FR-OPS-1, FR-DOM-8 |
| `cli::secrets::rotate_master` | The flow of §12.1 against the harness ends with no ciphertext under the old `kid` and no `PM_MASTER_KEY_NEXT` | [Security §6.2](security.md#62-rotation-procedures) |
| `cli::secrets::rotate_signing_key` | `keys rotate thread\|link\|cursor\|web_bot_auth` calls the platform endpoint, `--revoke-previous` adds `revoke_previous=true`, and the output shows the new kid (a 43-character thumbprint for `web_bot_auth`) and the previous kid with `verify_until` or `revoked`, never key material; `422 web_bot_auth_disabled` is exit 7; `keys rotate key_…` still rotates an API key; mixed flags are exit 2 | [Security §6.2](security.md#62-rotation-procedures), FR-IDN-8 |
| `cli::dlq::j8_list_redrive` | `list` passes `queue`, `status` and `tenant_id` to `GET /v1/platform/dlq`; `redrive` posts once per item and reports partial failures; no Cloudflare, D1 or Queues call is made | FR-OPS-4, [J8] |
| `cli::jobs::start_get` | `jobs start` builds the job body (repeated `--identity` resolved to `identity_ids`; `--tenant` required) and `jobs get` reads it back | [J3] |
| `cli::waitlist::invite` | `--count` outside 1–500 is exit 2 before any request; the result prints `invited` and `waiting` | FR-CON-8 |
| `cli::domains::local_token_apex` | Without `--local-token`, `422 cf_token_required` and `422 transport_unavailable` are exit 3 and no Cloudflare call is made; with it, the local prerequisites are checked first (another method or a subdomain is exit 2, no token or account ID exit 3), then on `cf_token_required` an apex `cloudflare_zone` is onboarded with the local token and registered through the D1 query API, found by account ID and database name, with `method` and `inbound` set; the Worker hook mints its monitor and emits `domain.created` | FR-DOM-1, [H5] |
| `cli::domains::add_methods` | Each `--method` with its flags produces the body of §18.2; a flag for another method is exit 2; the SMTP password comes only from stdin and appears in no argument or output; the records table prints `name` and `host` | FR-DOM-7, FR-DOM-11, [N17] |
| `cli::domains::update_probe_forwarding` | `domains update` sends `transport` or `smtp` (a tenant key's `--transport` is exit 4); `domains probe` prints the `probe_id`; `addresses test-forwarding` resolves an address to its IDs and posts | FR-DOM-10, FR-DOM-11, [J5] |
| `cli::domains::subscribe_manual` | A `manual` domain gets one subscription created through Wrangler with the local token and its ID recorded through D1; an existing matching subscription is reused; a domain that is not `manual` is a no-op with exit 0; no local token is exit 3 | FR-DOM-3, spike S9 fallback |
| `cli::members::invite_remove` | `members list\|invite\|remove` and `invitations revoke` call their endpoints; no seat is exit 8; removing the owner is exit 6 | FR-CON-4 |
| `cli::billing::plans_and_billing` | `plans list` sends no key; `billing set` sends only the flags given; `409 plan_managed_by_stripe` is exit 6 | FR-BILL-1 |
| `cli::usage::daily` | `usage` reads `GET /v1/usage`; `usage daily` passes `from`, `to` and `tenant_id` to `GET /v1/usage/daily` and prints the `assertions` and `http_signatures` columns; a platform key without `--tenant` or a profile tenant sends no `tenant_id` (never the default tenant) and `400 invalid_request` is exit 7 | FR-BILL-11 |
| `cli::keys::create_permissions_by_level` | `--level platform` without `--permissions` is exit 2 before any request, listing the allowed permissions; `identities:sign` on a platform key and a tenant-only permission on an identity key come back as `400 invalid_request` (`permission_not_allowed_for_level`), exit 7 | FR-KEY-2, FR-IDN-6 |
| `cli::identity_keys::lifecycle` | `list`, `create` (`201` and `200` both exit 0), `rotate` (with and without a previous key) and `revoke` (confirmation or `--yes`; unknown kid exit 5; already retired exit 0) call their endpoints and never print key material | FR-IDN-6, [O2], [O3] |
| `cli::assertions::create_and_verify` | `create` sends no `Idempotency-Key` and `--quiet` prints only the token; `verify` accepts a fresh token against the workerd harness with no API key, and exits 11 for a wrong audience, another issuer, an expired token, an unknown kid, `alg: none` and a paused identity (JWKS `404`); a JWKS network failure is exit 9; the JWKS URL is built from `--issuer`, never from the token | FR-IDN-7, [O1], [O4], [O5] |
| `cli::http_sign::headers_and_errors` | Prints the four headers as `Name: value` lines in order, or the response with `--json`; `--component` adds only `@method`, `@path` or `@query`; `422 web_bot_auth_disabled` is exit 7 and `403 policy_denied` exit 4 | FR-IDN-8, [O9], [O13] |
| `cli::webhooks::verify` | Valid signatures, rotation overlap (two signatures), tampered body, old timestamp | FR-WH-2 |
| `cli::ask::render_stream` | Recorded SSE streams for each status render as specified; `--json` prints the `done` data; `--tenant` posts to `POST /v1/tenants/{t}/search` with `mode: agentic`, and an identity key gets exit 4 | FR-SRCH-3 |
| `cli::landing_examples` | The landing-page examples run verbatim against the workerd harness and the recorded Cloudflare fake | M16 |

[E1]: ../edge-cases.md
[H5]: ../edge-cases.md
[I5]: ../edge-cases.md
[J3]: ../edge-cases.md
[J5]: ../edge-cases.md
[J8]: ../edge-cases.md
[J9]: ../edge-cases.md
[N17]: ../edge-cases.md
[N26]: ../edge-cases.md
[N30]: ../edge-cases.md
[O1]: ../edge-cases.md
[O2]: ../edge-cases.md
[O3]: ../edge-cases.md
[O4]: ../edge-cases.md
[O5]: ../edge-cases.md
[O9]: ../edge-cases.md
[O12]: ../edge-cases.md
[O13]: ../edge-cases.md
