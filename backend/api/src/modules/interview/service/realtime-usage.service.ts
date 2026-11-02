import { Inject, Injectable, Logger } from "@nestjs/common";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../../shared/prisma.service";
import { CandidateDomainError } from "../../candidate";

export type RealtimeUsageType = "STT_RELAY" | "INTERVIEWER_VOICE" | "INTERVIEWER_PREVIEW";
export type RealtimeReportedUsageType = Exclude<RealtimeUsageType, "STT_RELAY">;

export const REALTIME_USAGE_REPORT_TOKEN_TYPE = "realtime_usage_report";
const REPORT_TOKEN_TTL_SECONDS = 6 * 60 * 60;
// 연결 1회 보고 상한. 정상 면접 수십 배를 넘는 값은 조작으로 보고 거부한다.
const MAX_REPORTED_TOKENS = 5_000_000;
const MAX_REPORTED_RESPONSES = 10_000;
// relay가 OpenAI로 보내는 오디오는 24kHz 16bit mono PCM이다.
const PCM_BYTES_PER_MS = 48;

export type RealtimeUsageReportClaims = {
  tokenType: typeof REALTIME_USAGE_REPORT_TOKEN_TYPE;
  jti: string;
  userId: number;
  sessionId?: number;
  usageType: RealtimeReportedUsageType;
  model: string;
};

export type RealtimeTokenUsage = {
  inputTextTokens: number;
  inputAudioTokens: number;
  cachedInputTokens: number;
  outputTextTokens: number;
  outputAudioTokens: number;
};

export type RealtimeUsageReportInput = RealtimeTokenUsage & {
  usageReportToken: string;
  responseCount: number;
  startedAt?: string;
  endedAt?: string;
};

export type RecordSttRelayUsageInput = {
  userId: number;
  sessionId: number;
  model: string;
  audioBytes: number;
  startedAt: Date;
  endedAt: Date;
  providerUsage?: unknown;
};

type RealtimeTokenPrices = {
  textInput: number;
  textOutput: number;
  audioInput: number;
  audioOutput: number;
  cachedInput: number;
};

const logger = new Logger("RealtimeUsage");

@Injectable()
export class RealtimeUsageService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  issueReportToken(input: {
    userId: number;
    sessionId?: number;
    usageType: RealtimeReportedUsageType;
    model: string;
  }): string {
    const claims: RealtimeUsageReportClaims = {
      tokenType: REALTIME_USAGE_REPORT_TOKEN_TYPE,
      jti: randomUUID(),
      userId: input.userId,
      sessionId: input.sessionId,
      usageType: input.usageType,
      model: input.model,
    };
    return jwt.sign(claims, reportTokenSecret(), { expiresIn: REPORT_TOKEN_TTL_SECONDS });
  }

  async recordClientReport(input: RealtimeUsageReportInput) {
    const claims = verifyReportToken(input.usageReportToken);
    const usage = normalizeTokenUsage(input);
    const responseCount = boundedInteger(input.responseCount, "responseCount", MAX_REPORTED_RESPONSES);
    const prices = realtimeTokenPrices();
    // 단가가 하나라도 없으면 $0으로 오해하지 않도록 비용을 비워 두고 미계산 건으로 집계한다.
    const estimatedCostUsd = prices ? realtimeTokenCostUsd(usage, prices) : undefined;

    const data = {
      usageType: claims.usageType,
      usageSource: "CLIENT_REPORTED" as const,
      userId: BigInt(claims.userId),
      sessionId: claims.sessionId ? BigInt(claims.sessionId) : undefined,
      reportKey: claims.jti,
      modelName: claims.model,
      inputTokens: usage.inputTextTokens + usage.inputAudioTokens + usage.cachedInputTokens,
      outputTokens: usage.outputTextTokens + usage.outputAudioTokens,
      estimatedCostUsd,
      costMetadataJson: JSON.stringify({ ...usage, responseCount, pricesUsdPer1MTokens: prices }),
      startedAt: optionalDate(input.startedAt),
      endedAt: optionalDate(input.endedAt),
    };
    // 같은 연결의 재보고(페이지 이탈과 정상 종료가 겹치는 경우)는 마지막 누적값으로 덮어쓴다.
    await this.prisma.aiRealtimeUsageLog.upsert({
      where: { reportKey: claims.jti },
      create: data,
      update: data,
    });

    return { accepted: true, estimatedCostUsd: estimatedCostUsd ?? null };
  }

  async recordSttRelayUsage(input: RecordSttRelayUsageInput): Promise<void> {
    const audioInputMs = pcmBytesToMs(input.audioBytes);
    if (audioInputMs <= 0) return;
    const usdPerMinute = envNumber("AI_REALTIME_STT_USD_PER_MINUTE");
    try {
      await this.prisma.aiRealtimeUsageLog.create({
        data: {
          usageType: "STT_RELAY",
          usageSource: "SERVER_MEASURED",
          userId: BigInt(input.userId),
          sessionId: BigInt(input.sessionId),
          modelName: input.model,
          audioInputMs,
          estimatedCostUsd: usdPerMinute === undefined ? undefined : sttRelayCostUsd(audioInputMs, usdPerMinute),
          costMetadataJson: JSON.stringify({
            usdPerMinute,
            audioBytes: input.audioBytes,
            providerUsage: input.providerUsage,
          }),
          startedAt: input.startedAt,
          endedAt: input.endedAt,
        },
      });
    } catch (error) {
      // 사용량 기록 실패가 면접 진행을 막지 않도록 로그만 남긴다.
      logger.warn(`STT relay usage was not recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function pcmBytesToMs(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round(bytes / PCM_BYTES_PER_MS);
}

export function sttRelayCostUsd(audioInputMs: number, usdPerMinute: number): number {
  return round6((audioInputMs / 60_000) * usdPerMinute);
}

export function realtimeTokenCostUsd(usage: RealtimeTokenUsage, prices: RealtimeTokenPrices): number {
  return round6(
    (usage.inputTextTokens * prices.textInput +
      usage.inputAudioTokens * prices.audioInput +
      usage.cachedInputTokens * prices.cachedInput +
      usage.outputTextTokens * prices.textOutput +
      usage.outputAudioTokens * prices.audioOutput) /
      1_000_000,
  );
}

function verifyReportToken(token: string): RealtimeUsageReportClaims {
  let payload: Partial<RealtimeUsageReportClaims>;
  try {
    payload = jwt.verify(token, reportTokenSecret()) as Partial<RealtimeUsageReportClaims>;
  } catch {
    throw invalidReport("usageReportToken", "token is invalid or expired");
  }
  const usageType = payload.usageType;
  if (
    payload.tokenType !== REALTIME_USAGE_REPORT_TOKEN_TYPE ||
    typeof payload.jti !== "string" ||
    !Number.isInteger(payload.userId) ||
    (usageType !== "INTERVIEWER_VOICE" && usageType !== "INTERVIEWER_PREVIEW") ||
    typeof payload.model !== "string"
  ) {
    throw invalidReport("usageReportToken", "token payload is invalid");
  }
  return payload as RealtimeUsageReportClaims;
}

function normalizeTokenUsage(input: RealtimeTokenUsage): RealtimeTokenUsage {
  return {
    inputTextTokens: boundedInteger(input.inputTextTokens, "inputTextTokens", MAX_REPORTED_TOKENS),
    inputAudioTokens: boundedInteger(input.inputAudioTokens, "inputAudioTokens", MAX_REPORTED_TOKENS),
    cachedInputTokens: boundedInteger(input.cachedInputTokens, "cachedInputTokens", MAX_REPORTED_TOKENS),
    outputTextTokens: boundedInteger(input.outputTextTokens, "outputTextTokens", MAX_REPORTED_TOKENS),
    outputAudioTokens: boundedInteger(input.outputAudioTokens, "outputAudioTokens", MAX_REPORTED_TOKENS),
  };
}

function boundedInteger(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw invalidReport(field, `must be an integer between 0 and ${max}`);
  }
  return value;
}

function optionalDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function realtimeTokenPrices(): RealtimeTokenPrices | undefined {
  const prices = {
    textInput: envNumber("AI_REALTIME_TEXT_INPUT_USD_PER_1M_TOKENS"),
    textOutput: envNumber("AI_REALTIME_TEXT_OUTPUT_USD_PER_1M_TOKENS"),
    audioInput: envNumber("AI_REALTIME_AUDIO_INPUT_USD_PER_1M_TOKENS"),
    audioOutput: envNumber("AI_REALTIME_AUDIO_OUTPUT_USD_PER_1M_TOKENS"),
    cachedInput: envNumber("AI_REALTIME_CACHED_INPUT_USD_PER_1M_TOKENS"),
  };
  if (Object.values(prices).some((price) => price === undefined)) return undefined;
  return prices as RealtimeTokenPrices;
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function invalidReport(field: string, reason: string) {
  return new CandidateDomainError("COMMON_VALIDATION_FAILED", "Realtime usage report is invalid.", 400, [
    { field, reason },
  ]);
}

function reportTokenSecret(): string {
  return process.env.JWT_SECRET ?? "local-dev-jwt-secret-change-me";
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
