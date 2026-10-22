#!/usr/bin/env bash
# 시드 계정(dev.company@example.com 등)은 저장소에 공개된 기본 비밀번호를 쓴다.
# 공개 서버에 시드를 넣었다면 이 스크립트로 모든 LOCAL 계정 비밀번호를 .env의
# SEED_ACCOUNT_NEW_PASSWORD 값으로 바꾼다. infra/deploy 폴더에서 실행한다.
#   bash scripts/reset-seed-passwords.sh
set -euo pipefail

cd "$(dirname "$0")/.."

set -a
# shellcheck disable=SC1091
source .env
set +a

if [ -z "${SEED_ACCOUNT_NEW_PASSWORD:-}" ] || [ "${#SEED_ACCOUNT_NEW_PASSWORD}" -lt 8 ]; then
  echo "SEED_ACCOUNT_NEW_PASSWORD를 8자 이상으로 .env에 설정하세요." >&2
  exit 1
fi

# 앱과 같은 방식(bcrypt cost 12)으로 해시를 만든다.
hash="$(docker compose run --rm --no-deps -T -e NEW_PW="$SEED_ACCOUNT_NEW_PASSWORD" api \
  node -e "process.stdout.write(require('bcryptjs').hashSync(process.env.NEW_PW, 12))")"

if [[ ! "$hash" =~ ^\$2[aby]\$12\$.{53}$ ]]; then
  echo "비밀번호 해시 생성에 실패했습니다." >&2
  exit 1
fi

docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
  -v hash="$hash" \
  -c "update users set password_hash = :'hash', updated_at = now() where auth_provider = 'LOCAL';"

echo "LOCAL 계정 비밀번호를 변경했습니다."
