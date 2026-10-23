/**
 * PR #389 재현: 음성 인식(STT) 결과가 형식상 있지만 평가에 쓸 수 없을 때,
 * worker가 그 전사문으로 꼬리질문을 만들어 버리는지를 같은 입력으로 두 버전에서 비교한다.
 *
 * 실행 (대상 버전의 backend/worker 폴더에서):
 *   WORKER_SRC=<대상 checkout>/backend/worker/src LABEL=after OUT=result-after.json \
 *     npx tsx <이 파일 경로>
 *
 * 대상은 실제 OpenAiAiTaskHandler의 꼬리질문(FOLLOW_UP) 처리 경로다.
 * - 꼬리질문 생성 모델과 팩트체크 모델 호출은 횟수를 세는 대역(stub)으로 바꾼다.
 * - 팩트체크 대역은 샘플마다 정해 둔 "전사문 사용 가능 여부(transcriptUsability)"를 돌려준다.
 *   운영에서는 이 판정을 모델이 하며, 이 재현은 판정 이후 코드가 무엇을 하는지만 비교한다.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const workerSrc = requiredEnv("WORKER_SRC");
const label = requiredEnv("LABEL");
const out = requiredEnv("OUT");

type Usability = "USABLE" | "UNUSABLE";
interface Sample {
  id: string;
  title: string;
  transcript: string;
  // 운영에서 팩트체크 모델이 내릴 것으로 가정한 판정
  assumedUsability: Usability;
}

// 실제 면접에서 나오는 저품질 전사문 유형
const samples: Sample[] = [
  { id: "no-answer", title: "무응답 녹음", transcript: "[NO_ANSWER]", assumedUsability: "UNUSABLE" },
  { id: "too-short", title: "너무 짧은 인식", transcript: "음... 네 그", assumedUsability: "UNUSABLE" },
  {
    id: "hallucination",
    title: "무음 구간 STT 환각",
    transcript: "시청해 주셔서 감사합니다. 구독과 좋아요 부탁드립니다.",
    assumedUsability: "UNUSABLE",
  },
  {
    id: "garbled",
    title: "끊기고 반복된 문장",
    transcript: "캐시 캐시 장애를 하고 하고 해결 말이 끊긴 문장입니다.",
    assumedUsability: "UNUSABLE",
  },
  {
    id: "normal",
    title: "정상 답변",
    transcript: "트래픽이 몰리면 캐시 적중률이 떨어져 DB 부하가 커졌고, TTL을 분산하고 미리 채워서 해결했습니다.",
    assumedUsability: "USABLE",
  },
];

const load = (file: string) => import(pathToFileURL(join(workerSrc, file)).href);

async function main() {
  const { OpenAiAiTaskHandler } = await load("openai-ai-task.handler.ts");
  const { MockAiTaskHandler } = await load("mock-ai-task.handler.ts");
  const { InMemoryAiResultRepository } = await load("ai-result.repository.ts");

  const rows = [];
  for (const [index, sample] of samples.entries()) {
    const results = new InMemoryAiResultRepository();
    let followUpCalls = 0;
    let factCheckCalls = 0;

    const followUpProvider = {
      async generateFollowUpQuestion() {
        followUpCalls += 1;
        return {
          content: `방금 "${sample.transcript.slice(0, 18)}"라고 답하셨는데, 그때 어떤 판단을 하셨나요?`,
          model: "stub-follow-up",
        };
      },
    };
    const factCheckProvider = {
      async evaluate() {
        factCheckCalls += 1;
        return { transcriptUsability: sample.assumedUsability, claims: [], model: "stub-fact-check" };
      },
    };

    const handler = new OpenAiAiTaskHandler(
      new MockAiTaskHandler(results),
      results,
      followUpProvider,
      undefined,
      undefined,
      undefined,
      { provider: factCheckProvider, configuredModelVersion: "stub-fact-check", providerMode: "mock" },
    );

    let outcome: string;
    let detail = "";
    try {
      const handled = await handler.handle({
        processLogId: 100 + index,
        processType: "FOLLOW_UP",
        attempt: 1,
        inputRef: JSON.stringify({
          kind: "RECRUITING_FOLLOW_UP",
          payload: {
            sessionId: 8,
            answerId: 200 + index,
            sessionQuestionId: 300 + index,
            previousQuestion: "서비스 장애를 해결한 경험을 설명해주세요.",
            transcript: sample.transcript,
            jobDescription: "백엔드 시스템 운영",
            ncsQuestionMode: "EXPERIENCE_BEHAVIOR",
            answerTimeSec: 90,
            ncsBindings: [{
              criterionId: 1,
              criterionTitleSnapshot: "문제 해결력",
              ncsProfileId: "PROBLEM_SOLVING",
              ncsProfileVersion: "2025.12-v1",
              alignmentStatus: "ALIGNED",
              bindingOrder: 1,
            }],
          },
        }),
      });
      await handled.finalSave?.();
      const followUp = results.followUpQuestions.find((item: { required: boolean }) => item.required);
      outcome = followUp ? "FOLLOW_UP_CREATED" : "NO_FOLLOW_UP";
      detail = followUp?.content ?? "";
    } catch (error) {
      const category = (error as { category?: string }).category ?? "ERROR";
      outcome = category;
      detail = error instanceof Error ? error.message : String(error);
    }

    rows.push({
      sample: sample.id,
      title: sample.title,
      transcript: sample.transcript,
      assumedUsability: sample.assumedUsability,
      outcome,
      detail,
      aiCalls: { factCheck: factCheckCalls, followUp: followUpCalls },
    });
    console.log(`[${label}] ${sample.id}: ${outcome} (factCheck=${factCheckCalls}, followUp=${followUpCalls})`);
  }

  writeFileSync(out, `${JSON.stringify({ label, ranAt: new Date().toISOString(), rows }, null, 2)}\n`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
