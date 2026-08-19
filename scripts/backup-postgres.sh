#!/usr/bin/env bash
# Дамп Postgres в backups/caspian-YYYYMMDD-HHMM.sql.gz (хранить ~7 копий).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
ts=$(date +%Y%m%d-%H%M)
out="backups/caspian-${ts}.sql.gz"
docker compose exec -T postgres pg_dump -U caspian caspian | gzip > "$out"
ls -1t backups/caspian-*.sql.gz 2>/dev/null | tail -n +8 | xargs -r rm -f
echo "Wrote $out"
