import assert from "node:assert/strict";
import {
  buildRealtimeUsageReport,
  createRealtimeUsageAccumulator,
  extractRealtimeResponseUsage,
  sendRealtimeUsageReport,
} from "./realtime-usage-report";

const responseDone = {
  type: "response.done",
  response: {
    status: "completed",
    usage: {
      input_tokens: 1200,
      output_tokens: 1300,
      input_token_details: {
        text_tokens: 1200,
        audio_tokens: 0,
        cached_tokens: 1000,
        cached_tokens_details: { text_tokens: 1000, audio_tokens: 0 },
      },
      output_token_details: { text_tokens: 100, audio_tokens: 1200 },
    },
  },
};

// cached token은 입력에서 빼고 따로 센다.
assert.deepEqual(extractRealtimeResponseUsage(responseDone), {
  inputTextTokens: 200,
  inputAudioTokens: 0,
  cachedInputTokens: 1000,
  outputTextTokens: 100,
  outputAudioTokens: 1200,
});

// cached 세부 항목이 없으면 text 입력에서 뺀다.
assert.deepEqual(
  extractRealtimeResponseUsage({
    type: "response.done",
    response: { usage: { input_token_details: { text_tokens: 50, cached_tokens: 80 }, output_token_details: {} } },
  }),
  { inputTextTokens: 0, inputAudioTokens: 0, cachedInputTokens: 50, outputTextTokens: 0, outputAudioTokens: 0 },
);

assert.equal(extractRealtimeResponseUsage({ type: "response.created", response: { usage: {} } }), undefined);
assert.equal(extractRealtimeResponseUsage({ type: "response.done", response: {} }), undefined);
assert.equal(extractRealtimeResponseUsage("not-json"), undefined);

const accumulator = createRealtimeUsageAccumulator();
accumulator.add(responseDone);
accumulator.add({ type: "output_audio_buffer.started" });
accumulator.add(responseDone);
assert.equal(accumulator.responseCount(), 2);
assert.equal(accumulator.totals().outputAudioTokens, 2400);

const startedAt = new Date("2026-11-01T00:00:00.000Z");
const endedAt = new Date("2026-11-01T00:15:00.000Z");
const report = buildRealtimeUsageReport({ usageReportToken: "signed-token", accumulator, startedAt, endedAt });
assert.deepEqual(report, {
  usageReportToken: "signed-token",
  responseCount: 2,
  inputTextTokens: 400,
  inputAudioTokens: 0,
  cachedInputTokens: 2000,
  outputTextTokens: 200,
  outputAudioTokens: 2400,
  startedAt: startedAt.toISOString(),
  endedAt: endedAt.toISOString(),
});

// mock provider처럼 token이 없거나 응답이 없으면 보고하지 않는다.
assert.equal(buildRealtimeUsageReport({ usageReportToken: undefined, accumulator, startedAt, endedAt }), undefined);
assert.equal(
  buildRealtimeUsageReport({
    usageReportToken: "signed-token",
    accumulator: createRealtimeUsageAccumulator(),
    startedAt,
    endedAt,
  }),
  undefined,
);

const calls: Array<{ url: string; init?: RequestInit }> = [];
const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(url), init });
  return new Response(null, { status: 202 });
}) as typeof fetch;
sendRealtimeUsageReport(report!, "https://initview.cloud", fetcher);
assert.equal(calls.length, 1);
assert.equal(calls[0].url, "https://initview.cloud/api/v1/realtime-usage/reports");
assert.equal(calls[0].init?.keepalive, true);
assert.equal(JSON.parse(String(calls[0].init?.body)).responseCount, 2);

// 전송 실패는 삼킨다.
sendRealtimeUsageReport(report!, "https://initview.cloud", (() => {
  throw new Error("offline");
}) as typeof fetch);

console.log("realtime-usage-report spec passed");
