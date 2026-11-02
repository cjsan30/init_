import jwt from "jsonwebtoken";
import type { PrismaService } from "../../../shared/prisma.service";
import { CandidateDomainError } from "../../candidate";
import {
  pcmBytesToMs,
  realtimeTokenCostUsd,
  RealtimeUsageService,
  sttRelayCostUsd,
} from "./realtime-usage.service";

describe("RealtimeUsageService", () => {
  const envKeys = [
    "JWT_SECRET",
    "AI_REALTIME_STT_USD_PER_MINUTE",
    "AI_REALTIME_TEXT_INPUT_USD_PER_1M_TOKENS",
    "AI_REALTIME_TEXT_OUTPUT_USD_PER_1M_TOKENS",
    "AI_REALTIME_AUDIO_INPUT_USD_PER_1M_TOKENS",
    "AI_REALTIME_AUDIO_OUTPUT_USD_PER_1M_TOKENS",
    "AI_REALTIME_CACHED_INPUT_USD_PER_1M_TOKENS",
  ];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of envKeys) savedEnv[key] = process.env[key];
    process.env.JWT_SECRET = "realtime-usage-test-secret";
    process.env.AI_REALTIME_STT_USD_PER_MINUTE = "0.017";
    process.env.AI_REALTIME_TEXT_INPUT_USD_PER_1M_TOKENS = "4";
    process.env.AI_REALTIME_TEXT_OUTPUT_USD_PER_1M_TOKENS = "24";
    process.env.AI_REALTIME_AUDIO_INPUT_USD_PER_1M_TOKENS = "32";
    process.env.AI_REALTIME_AUDIO_OUTPUT_USD_PER_1M_TOKENS = "64";
    process.env.AI_REALTIME_CACHED_INPUT_USD_PER_1M_TOKENS = "0.4";
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("converts 24kHz 16bit mono PCM bytes to milliseconds and prices STT per minute", () => {
    expect(pcmBytesToMs(48_000 * 90)).toBe(90_000);
    expect(pcmBytesToMs(0)).toBe(0);
    expect(sttRelayCostUsd(90_000, 0.017)).toBe(0.0255);
  });

  it("prices realtime token usage per token category", () => {
    const cost = realtimeTokenCostUsd(
      {
        inputTextTokens: 1_000,
        inputAudioTokens: 0,
        cachedInputTokens: 10_000,
        outputTextTokens: 500,
        outputAudioTokens: 3_600,
      },
      { textInput: 4, textOutput: 24, audioInput: 32, audioOutput: 64, cachedInput: 0.4 },
    );
    // 0.004 + 0.004 + 0.012 + 0.2304
    expect(cost).toBe(0.2504);
  });

  it("records server-measured STT relay usage with an estimated cost", async () => {
    const prisma = createPrisma();
    const service = new RealtimeUsageService(prisma as unknown as PrismaService);

    await service.recordSttRelayUsage({
      userId: 7,
      sessionId: 11,
      model: "gpt-realtime-whisper",
      audioBytes: 48_000 * 60,
      startedAt: new Date("2026-11-01T00:00:00.000Z"),
      endedAt: new Date("2026-11-01T00:01:00.000Z"),
    });

    expect(prisma.aiRealtimeUsageLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        usageType: "STT_RELAY",
        usageSource: "SERVER_MEASURED",
        userId: 7n,
        sessionId: 11n,
        audioInputMs: 60_000,
        estimatedCostUsd: 0.017,
      }),
    });
  });

  it("skips STT relay rows without audio and swallows storage failures", async () => {
    const prisma = createPrisma();
    prisma.aiRealtimeUsageLog.create.mockRejectedValue(new Error("db down"));
    const service = new RealtimeUsageService(prisma as unknown as PrismaService);
    const base = {
      userId: 7,
      sessionId: 11,
      model: "gpt-realtime-whisper",
      startedAt: new Date(),
      endedAt: new Date(),
    };

    await service.recordSttRelayUsage({ ...base, audioBytes: 0 });
    expect(prisma.aiRealtimeUsageLog.create).not.toHaveBeenCalled();

    await expect(service.recordSttRelayUsage({ ...base, audioBytes: 48_000 })).resolves.toBeUndefined();
  });

  it("records a client report once per issued token and prices it on the server", async () => {
    const prisma = createPrisma();
    const service = new RealtimeUsageService(prisma as unknown as PrismaService);
    const token = service.issueReportToken({
      userId: 7,
      sessionId: 11,
      usageType: "INTERVIEWER_VOICE",
      model: "gpt-realtime-2",
    });
    const { jti } = jwt.decode(token) as { jti: string };

    const result = await service.recordClientReport({
      usageReportToken: token,
      responseCount: 9,
      inputTextTokens: 1_000,
      inputAudioTokens: 0,
      cachedInputTokens: 10_000,
      outputTextTokens: 500,
      outputAudioTokens: 3_600,
    });

    expect(result).toEqual({ accepted: true, estimatedCostUsd: 0.2504 });
    expect(prisma.aiRealtimeUsageLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { reportKey: jti },
        create: expect.objectContaining({
          usageType: "INTERVIEWER_VOICE",
          usageSource: "CLIENT_REPORTED",
          userId: 7n,
          sessionId: 11n,
          modelName: "gpt-realtime-2",
          inputTokens: 11_000,
          outputTokens: 4_100,
        }),
      }),
    );
  });

  it("leaves the cost empty instead of $0 when a realtime price is not configured", async () => {
    delete process.env.AI_REALTIME_AUDIO_OUTPUT_USD_PER_1M_TOKENS;
    delete process.env.AI_REALTIME_STT_USD_PER_MINUTE;
    const prisma = createPrisma();
    const service = new RealtimeUsageService(prisma as unknown as PrismaService);
    const token = service.issueReportToken({ userId: 7, usageType: "INTERVIEWER_VOICE", model: "gpt-realtime-2" });

    const result = await service.recordClientReport({
      usageReportToken: token,
      responseCount: 1,
      inputTextTokens: 100,
      inputAudioTokens: 0,
      cachedInputTokens: 0,
      outputTextTokens: 10,
      outputAudioTokens: 1200,
    });
    await service.recordSttRelayUsage({
      userId: 7,
      sessionId: 11,
      model: "gpt-realtime-whisper",
      audioBytes: 48_000,
      startedAt: new Date(),
      endedAt: new Date(),
    });

    expect(result).toEqual({ accepted: true, estimatedCostUsd: null });
    expect(prisma.aiRealtimeUsageLog.upsert.mock.calls[0][0].create.estimatedCostUsd).toBeUndefined();
    expect(prisma.aiRealtimeUsageLog.create.mock.calls[0][0].data.estimatedCostUsd).toBeUndefined();
  });

  it("rejects forged tokens and out-of-range usage", async () => {
    const prisma = createPrisma();
    const service = new RealtimeUsageService(prisma as unknown as PrismaService);
    const usage = {
      responseCount: 1,
      inputTextTokens: 0,
      inputAudioTokens: 0,
      cachedInputTokens: 0,
      outputTextTokens: 0,
      outputAudioTokens: 0,
    };
    const forged = jwt.sign({ tokenType: "realtime_usage_report", jti: "x", userId: 1 }, "other-secret");
    await expect(service.recordClientReport({ ...usage, usageReportToken: forged })).rejects.toBeInstanceOf(
      CandidateDomainError,
    );

    const token = service.issueReportToken({ userId: 1, usageType: "INTERVIEWER_PREVIEW", model: "gpt-realtime-2" });
    await expect(
      service.recordClientReport({ ...usage, usageReportToken: token, outputAudioTokens: 50_000_000 }),
    ).rejects.toBeInstanceOf(CandidateDomainError);
    expect(prisma.aiRealtimeUsageLog.upsert).not.toHaveBeenCalled();
  });
});

function createPrisma() {
  return {
    aiRealtimeUsageLog: {
      create: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
}
