# Pylota Mail site

The landing page and the docs, served together by one assets-only Cloudflare Worker
(`site/wrangler.jsonc`: no Worker script, no bindings).

```
site/
  wrangler.jsonc     Worker config: name, compatibility date, assets directory
  package.json       pins Wrangler 4.139.0 for deploys; package-lock.json holds every package's integrity hash
  check-live.sh      after a deploy: both hostnames over HTTPS, and HTTP redirects to HTTPS
  public/            everything that is served
    index.html       landing page
    404.html         served for unknown paths (assets.not_found_handling = "404-page")
    _headers         security headers and caching (parsed by Workers, never served)
    assets/          styles.css and app.js
    docs/            built by mdBook; not committed, do not edit by hand
```

The page loads nothing from a third party: no web fonts, no CDN, no analytics. `app.js` only
adds the theme toggle, code tabs and copy buttons; the page works without it.

## Deploy

Production is `https://pylotamail.com` (with `www.pylotamail.com`), Workers Custom Domains declared in
`wrangler.jsonc`. Cloudflare creates the DNS records and certificates on the first deploy.

**Automatically.** `.github/workflows/site.yml` builds the docs on every pull request that touches
`site/` or `docs/`, and on a push to `main` (or a manual run) deploys through the `production`
environment. It needs two secrets on that environment:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | An account-owned token (**Manage Account › Account API Tokens**) with the scope **Specified Workers** = `pylota-mail-site` and the role **Editor**, plus **Zone (pylotamail.com) › Workers Routes › Edit**. Nothing else: no account-wide **Workers Scripts › Edit**, which in Pylota's shared account would reach every Worker, and no **DNS › Edit**. The Custom Domains already exist, and redeploying a Worker without changing them needs only Editor (Cloudflare "Workers roles and permissions", read 2026-10-10). Editor cannot create a Worker: a brand-new site Worker is deployed once by hand with a wider token |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account that holds the `pylotamail.com` zone |

Secrets belong to one repository. Secrets that another repository uses for the same Cloudflare
account are not visible here; add them to this repository's `production` environment.

After deploying, the job runs `site/check-live.sh`. It checks that both hostnames serve the landing
page and the docs over HTTPS, and that plain HTTP redirects to HTTPS. Run it by hand the same way:

```bash
bash site/check-live.sh pylotamail.com www.pylotamail.com
```

**By hand**, from the repository root:

```bash
mdbook build docs                       # writes the docs to site/public/docs
cd site
npm ci --ignore-scripts                 # Wrangler from package-lock.json, integrity-checked
./node_modules/.bin/wrangler deploy
```

`docs/book.toml` sets `build-dir = "../site/public/docs"`, so the docs are served at `/docs/`.
Paths in `wrangler.jsonc` are relative to that file. The workflow pins mdBook 0.5.4; Wrangler 4.139.0 is
pinned in `package.json` and `package-lock.json`. To move Wrangler, read its changelog, then run
`npm install --save-exact --save-dev wrangler@<version>` in `site/` and commit both files; the workflow
never installs a version that is not in the lockfile.

### Before the first deploy

- `pylotamail.com` is also Pylota Mail Cloud's shared mail domain. The site only adds web records
  (the Custom Domains' `A`/`AAAA` records); the mail records (`MX`, SPF and DKIM `TXT`, `_dmarc`) are
  created by `pmail setup` and are unaffected. Do not add a `CNAME` at the apex or at `www`: a Custom
  Domain cannot be created on a hostname that already has one ([Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/),
  read 2026-10-09).
- Turn on **Always Use HTTPS** for the zone: **SSL/TLS › Edge Certificates › Always Use HTTPS**
  in the dashboard, or set the zone setting `always_use_https` to `"on"` through the API. The
  Worker serves every request it gets, plain HTTP included, and nothing in this repository can
  redirect by scheme: `_redirects` matches paths only. The HSTS header in `_headers` does not fill
  the gap either. Browsers ignore it on HTTP responses, so it only takes effect after a first HTTPS
  visit. The setting applies to every hostname in the zone, so it will cover `app.` and `api.` too
  ([Always Use HTTPS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/),
  read 2026-10-09). Until it is on, the deploy job's last step fails.
- The console (`app.pylotamail.com`) and the API (`api.pylotamail.com`) are served by the main
  `pylota-mail` Worker, not by this site.

### When a hostname does not resolve

If one browser or network reports `NXDOMAIN` (for example `DNS_PROBE_FINISHED_NXDOMAIN`) for a
hostname that works elsewhere, that browser or network looked the name up before the deploy created
its record and kept the "no such name" answer. The zone's SOA allows such an answer to be kept for
up to 30 minutes (minimum TTL 1800 seconds). Check the public view first:

```bash
dig +short @1.1.1.1 pylotamail.com A
```

If that returns addresses, the site is fine. Clear the browser's DNS cache
(`chrome://net-internals/#dns`, or `edge://net-internals/#dns` in Edge, then **Clear host cache**),
or wait for the cached answer to expire.

### Self-hosting the site

Replace the hostname in `routes` with one on a zone in your own account, or delete the `routes`
block to serve the site on `workers.dev` only.

## Preview locally

```bash
cd site && npm ci --ignore-scripts && ./node_modules/.bin/wrangler dev
```

Wrangler 4.139.0 (2026-09-24) runs the `2026-09-22` compatibility date locally. Older releases
cannot (4.114.0 bundles workerd 1.20260722.1); with one of those, add `--compatibility-date 2026-07-22` for a
local preview only.

## Headers and caching

`public/_headers` applies a strict Content-Security-Policy, HSTS, `nosniff`, a referrer policy
and a permissions policy to every path.

- `/assets/*` is cached for a year and marked `immutable`. The landing page links these files
  with a `?v=` query string: **change it in `index.html` and `404.html` whenever `styles.css` or
  `app.js` changes**, or browsers keep the old copy.
- `/docs/*` replaces the CSP with one that also allows inline scripts and styles. mdBook's page
  template has inline `<script>` blocks (theme, sidebar, `path_to_root`) and an inline `style`
  attribute; without this the docs lose their sidebar and theme switcher. Every source is still
  first-party.

## Docs theme

`docs/theme/pylota.css` restyles mdBook's built-in themes with the landing page's colours. It is
loaded through `additional-css` in `docs/book.toml`. Light and Rust use the light palette; Coal,
Navy and Ayu use the dark one.

Rust code blocks in mdBook are "runnable" by default, and `book.js` then fetches
`https://play.rust-lang.org/meta/crates` on every page that has one. The CSP blocks that request,
but it still logs an error. To stop it, set this in `docs/book.toml`:

```toml
[output.html.playground]
runnable = false
```
