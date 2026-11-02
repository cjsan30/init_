// 음성 면접관 Realtime 연결은 브라우저만 OpenAI와 직접 통신하므로 서버가 사용량을 볼 수 없다.
// OpenAI가 응답마다 보내는 `response.done` usage를 합산했다가 연결이 끝날 때 서버에 한 번 보고한다.

export interface RealtimeTokenUsage {
  inputTextTokens: number;
  inputAudioTokens: number;
  cachedInputTokens: number;
  outputTextTokens: number;
  outputAudioTokens: number;
}

export interface RealtimeUsageReport extends RealtimeTokenUsage {
  usageReportToken: string;
  responseCount: number;
  startedAt: string;
  endedAt: string;
}

export interface RealtimeUsageAccumulator {
  add(event: unknown): void;
  responseCount(): number;
  totals(): RealtimeTokenUsage;
}

const EMPTY_USAGE: RealtimeTokenUsage = {
  inputTextTokens: 0,
  inputAudioTokens: 0,
  cachedInputTokens: 0,
  outputTextTokens: 0,
  outputAudioTokens: 0,
};

export function createRealtimeUsageAccumulator(): RealtimeUsageAccumulator {
  let totals = { ...EMPTY_USAGE };
  let responses = 0;
  return {
    add(event) {
      const usage = extractRealtimeResponseUsage(event);
      if (!usage) return;
      responses += 1;
      totals = {
        inputTextTokens: totals.inputTextTokens + usage.inputTextTokens,
        inputAudioTokens: totals.inputAudioTokens + usage.inputAudioTokens,
        cachedInputTokens: totals.cachedInputTokens + usage.cachedInputTokens,
        outputTextTokens: totals.outputTextTokens + usage.outputTextTokens,
        outputAudioTokens: totals.outputAudioTokens + usage.outputAudioTokens,
      };
    },
    responseCount: () => responses,
    totals: () => ({ ...totals }),
  };
}

/**
 * `response.done.response.usage`를 과금 항목별로 나눈다. cached token은 입력 token에 포함돼 오므로
 * text/audio 입력에서 빼고 cached 단가로 따로 센다.
 */
export function extractRealtimeResponseUsage(event: unknown): RealtimeTokenUsage | undefined {
  const record = asRecord(event);
  if (record?.type !== "response.done") return undefined;
  const usage = asRecord(asRecord(record.response)?.usage);
  if (!usage) return undefined;
  const inputDetails = asRecord(usage.input_token_details);
  const outputDetails = asRecord(usage.output_token_details);
  const cachedDetails = asRecord(inputDetails?.cached_tokens_details);

  const inputText = count(inputDetails?.text_tokens);
  const inputAudio = count(inputDetails?.audio_tokens);
  const cached = count(inputDetails?.cached_tokens);
  const cachedAudio = Math.min(count(cachedDetails?.audio_tokens), inputAudio);
  const cachedText = cachedDetails ? Math.min(count(cachedDetails.text_tokens), inputText) : Math.min(cached, inputText);

  return {
    inputTextTokens: inputText - cachedText,
    inputAudioTokens: inputAudio - cachedAudio,
    cachedInputTokens: cachedText + cachedAudio,
    outputTextTokens: count(outputDetails?.text_tokens),
    outputAudioTokens: count(outputDetails?.audio_tokens),
  };
}

export function buildRealtimeUsageReport({
  usageReportToken,
  accumulator,
  startedAt,
  endedAt,
}: {
  usageReportToken: string | undefined;
  accumulator: RealtimeUsageAccumulator;
  startedAt: Date;
  endedAt: Date;
}): RealtimeUsageReport | undefined {
  if (!usageReportToken || accumulator.responseCount() === 0) return undefined;
  return {
    usageReportToken,
    responseCount: accumulator.responseCount(),
    ...accumulator.totals(),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
  };
}

/** 페이지를 떠나는 중에도 전송되도록 keepalive로 보내고, 실패해도 면접 흐름에는 영향을 주지 않는다. */
export function sendRealtimeUsageReport(
  report: RealtimeUsageReport,
  apiBaseUrl: string,
  fetcher: typeof fetch = fetch,
): void {
  try {
    void fetcher(`${apiBaseUrl}/api/v1/realtime-usage/reports`, {
      method: "POST",
      body: JSON.stringify(report),
      headers: { "Content-Type": "application/json" },
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    return;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}
