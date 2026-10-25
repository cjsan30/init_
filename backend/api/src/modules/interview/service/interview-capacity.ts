import { ERROR_CODES } from "@init/common";
import { CandidateDomainError } from "../../candidate";
import type { MaybePromise } from "../repository/interview.repository";

// 서버 한 대 배포에서 worker가 꼬리질문을 늦지 않게 만들 수 있도록 동시에 진행되는 면접 수를 제한한다.
// MAX_CONCURRENT_INTERVIEWS가 비어 있거나 0이면 제한하지 않는다(로컬 개발·기존 팀 배포 기본값).

const DEFAULT_ACTIVE_WINDOW_MINUTES = 45;

export interface InterviewCapacityConfig {
  maxConcurrent: number;
  activeWindowMinutes: number;
}

export interface InterviewCapacityCounter {
  countActiveInterviewSessions?(startedAfter: Date): MaybePromise<number>;
  hasActiveInterviewSessionForApplication?(applicationId: number, startedAfter: Date): MaybePromise<boolean>;
}

export function loadInterviewCapacityConfig(env: NodeJS.ProcessEnv = process.env): InterviewCapacityConfig {
  return {
    maxConcurrent: nonNegativeInteger(env.MAX_CONCURRENT_INTERVIEWS) ?? 0,
    activeWindowMinutes: positiveInteger(env.INTERVIEW_ACTIVE_WINDOW_MINUTES) ?? DEFAULT_ACTIVE_WINDOW_MINUTES,
  };
}

export async function assertInterviewCapacity(
  repository: InterviewCapacityCounter,
  options: { applicationId?: number; now?: Date; config?: InterviewCapacityConfig } = {},
): Promise<void> {
  const config = options.config ?? loadInterviewCapacityConfig();
  if (config.maxConcurrent <= 0 || !repository.countActiveInterviewSessions) return;

  const now = options.now ?? new Date();
  const startedAfter = new Date(now.getTime() - config.activeWindowMinutes * 60_000);

  // 이미 진행 중인 자기 면접으로 돌아오는 경우는 자리를 새로 차지하지 않으므로 막지 않는다.
  if (
    options.applicationId !== undefined &&
    repository.hasActiveInterviewSessionForApplication &&
    await repository.hasActiveInterviewSessionForApplication(options.applicationId, startedAfter)
  ) {
    return;
  }

  const active = await repository.countActiveInterviewSessions(startedAfter);
  if (active >= config.maxConcurrent) {
    throw new CandidateDomainError(
      ERROR_CODES.INTERVIEW_CAPACITY_EXCEEDED,
      "지금은 면접을 진행하는 인원이 많습니다. 잠시 후 다시 시도해주세요.",
      503,
      [{ field: "interview", reason: "CONCURRENT_LIMIT_REACHED", limit: config.maxConcurrent }],
    );
  }
}

function nonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = nonNegativeInteger(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}
