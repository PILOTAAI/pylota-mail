#!/usr/bin/env bash
# Checks the live site: each host serves the landing page and the docs over HTTPS, and
# plain HTTP redirects to HTTPS. The deploy job runs it after `wrangler deploy`; run it by
# hand the same way:
#
#   bash site/check-live.sh pylotamail.com www.pylotamail.com
#
# Each HTTPS request retries for up to two minutes. That covers a first deploy, while
# Cloudflare is still creating the DNS records and certificates.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <host>..." >&2
  exit 2
fi

fail=0
err() {
  if [ "${GITHUB_ACTIONS:-}" = true ]; then echo "::error::$*"; else echo "FAIL  $*" >&2; fi
  fail=1
}

for host in "$@"; do
  for path in / /docs/; do
    if curl -fsS --retry 10 --retry-all-errors --retry-delay 10 --retry-max-time 120 --max-time 15 \
      -o /dev/null "https://$host$path"; then
      echo "ok    https://$host$path"
    else
      err "https://$host$path did not answer 2xx"
    fi
  done

  # Always Use HTTPS answers 301. 308 is accepted too. A 200 means plain HTTP is served.
  got=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code} %{redirect_url}' "http://$host/" || true)
  case "$got" in
    "301 https://$host/" | "308 https://$host/") echo "ok    http://$host/ -> https://$host/" ;;
    *) err "http://$host/ answered '$got', not a redirect to https://$host/. Turn on Always Use HTTPS for the zone (site/README.md)." ;;
  esac
done

exit "$fail"
