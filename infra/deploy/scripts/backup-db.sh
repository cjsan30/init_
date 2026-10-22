#!/usr/bin/env bash
# PostgreSQL을 압축 덤프로 백업하고 최근 7개만 남긴다. infra/deploy 폴더 기준으로 동작한다.
#   bash scripts/backup-db.sh
# 매일 새벽 3시 자동 실행 예(crontab -e):
#   0 3 * * * cd /opt/init/infra/deploy && bash scripts/backup-db.sh >> backups/backup.log 2>&1
set -euo pipefail

cd "$(dirname "$0")/.."

set -a
# shellcheck disable=SC1091
source .env
set +a

mkdir -p backups
file="backups/init-$(date +%Y%m%d-%H%M%S).dump"

docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$file"
echo "백업 완료: $file ($(du -h "$file" | cut -f1))"

ls -1t backups/init-*.dump | tail -n +8 | xargs -r rm --
