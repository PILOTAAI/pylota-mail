# Pylota Mail site

The landing page and the docs, served together by one assets-only Cloudflare Worker
(`site/wrangler.jsonc`: no Worker script, no bindings).

```
site/
  wrangler.jsonc     Worker config: name, compatibility date, assets directory
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
| `CLOUDFLARE_API_TOKEN` | A token with **Account › Workers Scripts › Edit**, and **Zone (pylotamail.com) › Workers Routes › Edit** and **DNS › Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account that holds the `pylotamail.com` zone |

**By hand**, from the repository root:

```bash
mdbook build docs                                              # writes the docs to site/public/docs
npx --yes wrangler@4.139.0 deploy --config site/wrangler.jsonc
```

`docs/book.toml` sets `build-dir = "../site/public/docs"`, so the docs are served at `/docs/`.
Paths in `wrangler.jsonc` are relative to that file, so the command works from any directory.
The workflow pins mdBook 0.5.4 and Wrangler 4.139.0; change both there and here together.

### Before the first deploy

- `pylotamail.com` is also Pylota Mail Cloud's shared mail domain. The site only adds web records
  (the Custom Domains' `A`/`AAAA` records); the mail records (`MX`, SPF and DKIM `TXT`, `_dmarc`) are
  created by `pmail setup` and are unaffected. Do not add a `CNAME` at the apex or at `www`: a Custom
  Domain cannot be created on a hostname that already has one ([Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/),
  read 2026-10-09).
- The console (`app.pylotamail.com`) and the API (`api.pylotamail.com`) are served by the main
  `pylota-mail` Worker, not by this site.

### Self-hosting the site

Replace the hostname in `routes` with one on a zone in your own account, or delete the `routes`
block to serve the site on `workers.dev` only.

## Preview locally

```bash
npx --yes wrangler@4.139.0 dev --config site/wrangler.jsonc
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
