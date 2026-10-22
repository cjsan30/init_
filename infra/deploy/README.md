# init 단일 서버 배포 (저비용)

AWS 관리형 서비스(ECS, RDS, ElastiCache, S3, SQS, ALB) 대신 **서버 한 대에 Docker Compose로 전체를 올리는** 배포 구성이다.
1순위는 Oracle Cloud Always Free(ARM, 월 0원), 안 되면 Hetzner CX23(x86, 월 약 €6)을 쓴다.
기존 AWS 배포 구성은 `infra/aws`에 그대로 남아 있다.

## 구성

```text
브라우저 ──HTTPS──▶ Caddy (:80/:443, 인증서 자동 발급)
                    ├─ /api/*, /api-docs  ─▶ api (NestJS, WebSocket 포함)
                    ├─ /storage/<bucket>/(회사 로고, JD 이미지, 시드 로고)만 ─▶ seaweedfs
                    └─ 그 외              ─▶ frontend (Next.js)

api, worker ─▶ postgres · redis · seaweedfs(S3 호환) · elasticmq(SQS 호환)
migrate(일회성)  배포마다 prisma migrate deploy 실행
seed(수동)       데모 데이터 입력
```

| AWS 구성 | 이 구성 | 비고 |
| --- | --- | --- |
| ALB + CloudFront | Caddy | Let's Encrypt 인증서 자동 발급/갱신 |
| RDS PostgreSQL | `postgres:16-alpine` | 볼륨 `postgres-data` |
| ElastiCache | `redis:7-alpine` | AOF 저장 |
| S3 | SeaweedFS | 외부 포트 없음. 공개 파일 경로만 Caddy가 노출 |
| SQS + DLQ | ElasticMQ | 큐 이름, 가시성 900초, DLQ(3회)를 AWS 설정과 동일하게 맞춤 |
| ECR | GHCR | `.github/workflows/images.yml`이 amd64/arm64 이미지 빌드 |

- 프론트는 HTTPS로 접속하면 브라우저 origin을 API 주소로 쓰므로, 이미지 하나로 어떤 도메인에서도 동작한다.
- 업로드/영상 재생은 API를 거치므로 저장소는 비공개로 둔다. 공개 URL(`S3_PUBLIC_BASE_URL`)이 필요한 로고와 JD 이미지만 Caddy가 GET으로 열어준다.
- S3와 SQS 주소가 달라서 `AWS_SQS_ENDPOINT_URL`(SQS 전용 주소)을 사용한다. 비우면 기존처럼 `AWS_ENDPOINT_URL`을 쓴다.

## 서버 사양

앱 3개(frontend/api/worker)와 DB, 큐, 저장소를 합쳐 메모리 3GB 안팎을 쓴다.

| 서버 | 사양 | 월 비용 | 메모 |
| --- | --- | --- | --- |
| Oracle Always Free | ARM 2 OCPU / 12GB | 0원 | 1순위. 용량 부족으로 생성이 안 될 수 있음 |
| Hetzner CX23 | x86 2 vCPU / 4GB | 약 €6 | 대안. 스왑 2GB 추가 권장, 유럽 리전만 |

## 1. 이미지 빌드 (GitHub)

1. 이미지는 자동으로 빌드된다. dev에 push하면 `dev`, `sha-<커밋>` 태그가, main에 머지되면 `latest`가 만들어진다(backend/frontend/infra/docker 변경 시). images.yml이 main에 반영된 뒤에는 GitHub Actions → **Images** → Run workflow로 수동 실행도 된다.
2. GHCR 패키지 3개(`init-api`, `init-worker`, `init-frontend`)는 처음에 **비공개**로 만들어진다. 둘 중 하나를 한다.
   - GitHub → 프로필 → Packages → 각 패키지 → Package settings → **Change visibility → Public** (서버에서 로그인 불필요)
   - 또는 서버에서 `read:packages` 권한 토큰으로 `docker login ghcr.io` 실행

## 2-A. Oracle Cloud Always Free 서버 만들기

1. Oracle Cloud 가입. **홈 리전은 나중에 바꿀 수 없다.** Always Free 서버는 홈 리전에서만 만들 수 있으므로 `South Korea Central (Seoul)` 또는 `South Korea North (Chuncheon)`을 고른다.
2. Compute → Instances → Create instance
   - Image: **Canonical Ubuntu 24.04** (aarch64)
   - Shape: **VM.Standard.A1.Flex**, OCPU 2, Memory 12GB (2026년 기준 Always Free 한도)
   - Boot volume: 50~100GB (Always Free 블록 스토리지 합계 200GB)
   - SSH 공개키 등록, Public IPv4 할당
   - `Out of capacity`가 나오면 시간을 두고 다시 시도한다. 계속 안 되면 Hetzner로 넘어간다.
3. 네트워크 → 인스턴스의 VCN → Security List → Ingress 규칙 추가: TCP 80, TCP 443 (소스 `0.0.0.0/0`). 선택: UDP 443(HTTP/3).
4. **OS 방화벽도 열어야 한다.** Oracle Ubuntu 이미지는 iptables가 기본으로 막고 있다.
   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```
5. 참고: 무료 계정은 7일 동안 CPU·메모리·네트워크 사용률이 매우 낮으면 인스턴스가 회수될 수 있다. Pay As You Go로 전환하면 이 정책을 피할 수 있지만, 무료 한도를 넘는 자원을 만들면 과금되므로 예산 알림을 먼저 걸어 둔다.

## 2-B. Hetzner CX23 서버 만들기 (대안)

1. Cloud Console → Add Server → Ubuntu 24.04, **CX23**, SSH 키 등록.
2. Firewall: TCP 22, 80, 443 허용.
3. 메모리가 4GB라 스왑을 추가한다.
   ```bash
   sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
   sudo mkswap /swapfile && sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```

## 3. 공통: Docker 설치와 배포

1. Docker 설치 (Ubuntu)
   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker "$USER"   # 다시 로그인
   ```
2. 도메인의 DNS **A 레코드**를 서버 공인 IP로 지정한다. Cloudflare를 쓰면 처음에는 프록시를 끈 상태(DNS only)로 둔다.
3. 배포 파일 받기
   ```bash
   sudo mkdir -p /opt/init && sudo chown "$USER" /opt/init
   git clone https://github.com/cjsan30/init_.git /opt/init
   cd /opt/init/infra/deploy
   cp .env.example .env
   ```
4. `.env` 채우기: `DOMAIN`, `ACME_EMAIL`, 비밀값(`openssl rand -hex 32`), SMTP, `OPENAI_API_KEY`. 테스트 이미지를 쓰려면 `IMAGE_TAG=dev`.
5. 실행
   ```bash
   docker compose pull
   docker compose up -d
   docker compose ps
   curl -fsS "https://$(grep ^DOMAIN= .env | cut -d= -f2)/api/v1/health"
   ```
6. (선택) 데모 데이터 넣기. 시드 계정은 저장소에 공개된 비밀번호를 쓰므로 **반드시 바로 바꾼다.**
   ```bash
   docker compose --profile tools run --rm seed
   bash scripts/reset-seed-passwords.sh   # .env의 SEED_ACCOUNT_NEW_PASSWORD 사용
   ```

## 운영

| 작업 | 명령 (`/opt/init/infra/deploy`에서) |
| --- | --- |
| 새 이미지로 업데이트 | `git pull && docker compose pull && docker compose up -d` (마이그레이션 자동 적용) |
| 로그 보기 | `docker compose logs -f api worker` |
| DB 백업 | `bash scripts/backup-db.sh` (최근 7개 보관, cron 예시는 스크립트 상단) |
| DB 복원 | `docker compose exec -T postgres pg_restore -U init -d init --clean < backups/<파일>.dump` |
| 전체 중지 | `docker compose down` (볼륨/데이터는 유지) |

- 외부에 열리는 포트는 80/443뿐이다. DB, Redis, 저장소, 큐는 Docker 내부 네트워크에서만 접근된다.
- 백업 파일은 서버 디스크에만 남으므로, 중요한 데이터가 생기면 다른 곳으로 복사해 둔다.

## 검증 상태

- 구성 파일 문법(`docker compose config`)과 SQS 전용 주소 코드(단위 테스트)는 확인했다.
- 실제 서버에서의 전체 동작(인증서 발급, SeaweedFS/ElasticMQ 연동, ARM 이미지 실행)은 첫 배포 때 확인해야 한다.
