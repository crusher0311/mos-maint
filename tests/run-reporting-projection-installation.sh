#!/usr/bin/env bash
set -euo pipefail
# Optional arguments are PostgreSQL bin directories, allowing a PG16/PG17 matrix.
# Never accept a database URL, password, or existing data directory.
if (($# == 0)); then set -- "$(dirname "$(command -v postgres)")"; fi
for bin in "$@"; do
  env -i PATH="$bin:$PATH" HOME="$HOME" bash -eu -o pipefail -c '
    umask 077
    version=$(postgres --version)
    major=$(echo "$version" | sed -E "s/.* ([0-9]+).*/\1/")
    if ((major < 16)); then echo "PostgreSQL 16+ required" >&2; exit 1; fi
    tmp=$(mktemp -d /tmp/reporting-install.XXXXXX)
    trap '\''pg_ctl -D "$tmp/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$tmp"'\'' EXIT
    initdb -D "$tmp/data" -U fixture_admin -A trust --no-locale >"$tmp/init.log"
    pg_ctl -D "$tmp/data" -l "$tmp/server.log" \
      -o "-p 5432 -h \"\" -k $tmp -c invoice_preview.disposable=yes" start >/dev/null
    echo "Testing $version"
    NODE_OPTIONS="--require ./tests/helpers/deny-network-egress.cjs" \
      node --import tsx tests/reporting-projection-installation.test.ts "$tmp"
  '
done
