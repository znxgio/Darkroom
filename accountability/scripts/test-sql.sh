#!/usr/bin/env bash
# Spins up a throwaway local Postgres, applies migrations, runs tests/sql/test_*.sql.
set -euo pipefail
cd "$(dirname "$0")/.."
PGBIN=${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}
DIR=$(mktemp -d)
PORT=${PGPORT_TEST:-55432}
if [ "$(id -u)" = 0 ]; then RUN="runuser -u postgres --"; chown postgres "$DIR"; else RUN=""; fi
trap '$RUN "$PGBIN/pg_ctl" -D "$DIR" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$DIR"' EXIT
$RUN "$PGBIN/initdb" -D "$DIR" -U postgres -A trust >/dev/null
$RUN "$PGBIN/pg_ctl" -D "$DIR" -o "-p $PORT -k $DIR -c listen_addresses=''" -w start >/dev/null
P="psql -h $DIR -p $PORT -U postgres -v ON_ERROR_STOP=1 -q"
$P -c 'create database t' >/dev/null
$P -d t -f tests/sql/stub_supabase.sql
for f in supabase/migrations/*.sql; do $P -d t -f "$f"; done
$P -d t -f tests/sql/after_migrations.sql
for f in tests/sql/test_*.sql; do echo "== $f"; $P -d t -f "$f"; done
