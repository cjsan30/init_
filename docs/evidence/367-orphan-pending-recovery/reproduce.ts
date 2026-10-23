/**
 * PR #367 재현: 후속 SQS 발행 실패로 "아무도 실행하지 않는 PENDING 작업"이 생기는지,
 * 그리고 복구 스캔이 그 작업을 다시 살려내는지를 같은 시나리오로 비교한다.
 *
 * 실행 (대상 버전의 backend/worker 폴더에서):
 *   WORKER_SRC=<대상 checkout>/backend/worker/src LABEL=after OUT=result-after.json \
 *     npx tsx <이 파일 경로>
 *
 * 공통: 문서 추출 작업(21)이 끝나면 DB 트랜잭션이 후속 작업(22, 개인화 질문 생성)을 PENDING으로 만들고
 * SQS에 발행한다. 실제 코드(prisma-ai-result.repository.ts)와 같이, 같은 지원서로 다시 실행되면
 * 배치가 이미 있으므로 후속 작업을 다시 만들지 않는다.
 *
 * MODE=denied — 발행이 오류로 실패(실제 장애 #362, worker의 sqs:SendMessage 권한 누락).
 *   처음 FIX_AT 분 동안은 모든 발행이 실패하고, 그 뒤 권한이 고쳐진다(#365 배포).
 * MODE=crash — DB 커밋 직후, 발행 전에 worker가 죽음(배포 교체·OOM 등). 오류가 남지 않는다.
 *   다음 tick부터 새 worker 인스턴스가 이어서 돈다.
 *
 * 시간 축소: 1 tick = 1초 = 실제 1분. 복구 기준 15분 → 15초, 스캔 간격 1분 → 1초.
 *
 * 저장소와 큐는 worker의 InMemory 구현을 쓴다. 외부 서비스(DB, SQS, OpenAI) 없이
 * 실행 순서와 상태 전이만 결정적으로 비교하기 위해서다.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const workerSrc = requiredEnv("WORKER_SRC");
const label = requiredEnv("LABEL");
const out = requiredEnv("OUT");
const mode = requiredEnv("MODE");
if (mode !== "denied" && mode !== "crash") throw new Error("MODE must be denied or crash");

const TICK_MS = 1_000; // 1 tick = 실제 1분
const TOTAL_TICKS = 30;
const FIX_AT = 5; // 5분 뒤 권한 수정

type Job = { processLogId: number; processType: string; inputRef: string; attempt: number };

const load = (file: string) => import(pathToFileURL(join(workerSrc, file)).href);

async function main() {
  const { AiWorkerRunner } = await load("worker-runner.ts");
  const { InMemoryAiJobQueue } = await load("queue.ts");
  const { InMemoryAiProcessLogRepository } = await load("process-log.repository.ts");

  const startedAt = Date.now();
  const minute = () => Math.floor((Date.now() - startedAt) / TICK_MS);
  const publishLog: Array<{ minute: number; processLogId: number; ok: boolean }> = [];

  let crashed = false;
  class FaultInjectedQueue extends InMemoryAiJobQueue {
    async publish(job: Job): Promise<void> {
      if (mode === "crash" && !crashed && job.processLogId === 22) {
        // 발행 직전에 프로세스가 죽는다: 이 호출은 끝나지 않고, 보상 코드도 실행되지 않는다.
        crashed = true;
        publishLog.push({ minute: minute(), processLogId: job.processLogId, ok: false });
        return new Promise<void>(() => undefined);
      }
      const ok = mode === "crash" || minute() >= FIX_AT;
      publishLog.push({ minute: minute(), processLogId: job.processLogId, ok });
      if (!ok) throw new Error("AccessDenied: sqs:SendMessage");
      await super.publish(job);
    }
  }

  const source: Job = {
    processLogId: 21,
    processType: "DOCUMENT_EXTRACT",
    inputRef: JSON.stringify({ applicationId: 206, attempt: 1 }),
    attempt: 1,
  };
  const followUp: Job = {
    processLogId: 22,
    processType: "RESUME_QUESTION_GENERATE",
    inputRef: JSON.stringify({ applicationId: 206, inputVersion: "input-206", attempt: 1 }),
    attempt: 1,
  };

  // 원본 메시지는 API가 이미 발행해 큐에 들어 있다(API에는 권한이 있었다).
  const queue = new FaultInjectedQueue([
    { messageId: "m-21", receiptHandle: "r-21", job: source, receiveCount: 1 },
  ]);
  const repository = new InMemoryAiProcessLogRepository();
  let batchExists = false;
  const handled: Array<{ minute: number; processLogId: number }> = [];

  const handler = {
    async handle(job: Job) {
      handled.push({ minute: minute(), processLogId: job.processLogId });
      if (job.processType === "DOCUMENT_EXTRACT") {
        return {
          outputRef: "document:extracted:206",
          guardrail: { result: "PASS", reason: null },
          // 실제 트랜잭션과 같이 후속 작업을 PENDING으로 먼저 만들고, 이미 있으면 다시 만들지 않는다.
          finalSave: async () => {
            if (batchExists) return [];
            batchExists = true;
            await repository.ensurePending(followUp);
            return [followUp];
          },
        };
      }
      return { outputRef: "questions:206", guardrail: { result: "PASS", reason: null } };
    },
  };

  const newRunner = () =>
    new AiWorkerRunner(queue, repository, handler, {
      // #367 이후 버전만 읽는 옵션. 이전 버전은 이 값을 무시한다.
      orphanPendingThresholdMs: 15 * TICK_MS,
      orphanRecoveryIntervalMs: TICK_MS,
      onFailure: async () => undefined,
      onOrphanRecoveryFailure: () => undefined,
    });
  let runner = newRunner();

  const statusOf = (id: number): string | null => {
    try {
      return repository.get(id)?.status ?? null;
    } catch {
      return null;
    }
  };

  const failureReasonOf = (id: number): string | null => {
    try {
      return repository.get(id)?.failure?.reason ?? null;
    } catch {
      return null;
    }
  };

  const timeline: Array<{ minute: number; source: string | null; followUp: string | null; queued: number }> = [];
  for (let tick = 0; tick < TOTAL_TICKS; tick += 1) {
    const due = startedAt + tick * TICK_MS;
    await sleep(Math.max(0, due - Date.now()));
    const batch = runner.processBatch().catch(() => undefined);
    // 죽은 worker는 기다리지 않는다. 한 tick 안에 끝나지 않으면 새 인스턴스로 교체한다.
    const finished = await Promise.race([batch.then(() => true), sleep(TICK_MS * 0.8).then(() => false)]);
    if (!finished) runner = newRunner();
    const queued = (await queue.receive(10)).length;
    timeline.push({ minute: tick, source: statusOf(21), followUp: statusOf(22), queued });
  }

  const final = timeline[timeline.length - 1];
  const result = {
    label,
    mode,
    scenario: {
      tickMeaning: "1 tick = 1 minute",
      totalMinutes: TOTAL_TICKS,
      permissionFixedAtMinute: FIX_AT,
      orphanThresholdMinutes: 15,
    },
    finalState: {
      source: final.source,
      followUp: final.followUp,
      followUpFailureReason: failureReasonOf(22),
    },
    followUpCompletedAtMinute: timeline.find((row) => row.followUp === "COMPLETED")?.minute ?? null,
    followUpHandledCount: handled.filter((row) => row.processLogId === 22).length,
    publishLog,
    handled,
    timeline,
  };
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    `[${label} / ${mode}] source=${final.source} followUp=${final.followUp} ` +
      `completedAt=${result.followUpCompletedAtMinute ?? "never"} publishes=${publishLog.map((p) => `${p.minute}:${p.processLogId}:${p.ok ? "ok" : "fail"}`).join(",")}`,
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

// crash 시나리오에서 버려진 worker의 heartbeat 타이머가 남으므로 끝나면 직접 종료한다.
main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
