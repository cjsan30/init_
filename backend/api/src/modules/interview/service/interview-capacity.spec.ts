import { CandidateDomainError } from "../../candidate";
import { InMemoryInterviewRepository } from "../repository/in-memory-interview.repository";
import { assertInterviewCapacity, loadInterviewCapacityConfig } from "./interview-capacity";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

function repositoryWithSessions(
  sessions: Array<{ sessionId: number; applicationId?: number; status?: "IN_PROGRESS" | "READY" | "COMPLETED"; startedMinutesAgo: number }>,
) {
  const repository = new InMemoryInterviewRepository();
  for (const session of sessions) {
    repository.saveRecruitingRuntimeSession({
      sessionId: session.sessionId,
      applicationId: session.applicationId ?? 1000 + session.sessionId,
      candidateId: 2000 + session.sessionId,
      interviewType: "RECRUITING",
      sessionMode: "STANDARD",
      status: session.status ?? "IN_PROGRESS",
      showQuestionText: true,
      currentQuestionIndex: 0,
      questionIds: [1],
      startedAt: minutesAgo(session.startedMinutesAgo),
      updatedAt: minutesAgo(session.startedMinutesAgo),
    });
  }
  return repository;
}

describe("interview capacity", () => {
  const config = { maxConcurrent: 2, activeWindowMinutes: 45 };

  it("reads the limit from env and treats empty or zero as unlimited", () => {
    expect(loadInterviewCapacityConfig({ MAX_CONCURRENT_INTERVIEWS: "5", INTERVIEW_ACTIVE_WINDOW_MINUTES: "30" })).toEqual({
      maxConcurrent: 5,
      activeWindowMinutes: 30,
    });
    expect(loadInterviewCapacityConfig({})).toEqual({ maxConcurrent: 0, activeWindowMinutes: 45 });
    expect(loadInterviewCapacityConfig({ MAX_CONCURRENT_INTERVIEWS: "abc", INTERVIEW_ACTIVE_WINDOW_MINUTES: "0" })).toEqual({
      maxConcurrent: 0,
      activeWindowMinutes: 45,
    });
  });

  it("does not limit when the limit is unset", async () => {
    const repository = repositoryWithSessions([1, 2, 3].map((id) => ({ sessionId: id, startedMinutesAgo: 1 })));
    await expect(
      assertInterviewCapacity(repository, { now: NOW, config: { maxConcurrent: 0, activeWindowMinutes: 45 } }),
    ).resolves.toBeUndefined();
  });

  it("allows a new interview while the active count is below the limit", async () => {
    const repository = repositoryWithSessions([{ sessionId: 1, startedMinutesAgo: 5 }]);
    await expect(assertInterviewCapacity(repository, { now: NOW, config })).resolves.toBeUndefined();
  });

  it("rejects a new interview with 503 once the limit is reached", async () => {
    const repository = repositoryWithSessions([
      { sessionId: 1, startedMinutesAgo: 5 },
      { sessionId: 2, startedMinutesAgo: 10 },
    ]);
    await expect(assertInterviewCapacity(repository, { now: NOW, config })).rejects.toMatchObject({
      code: "INTERVIEW_CAPACITY_EXCEEDED",
      statusCode: 503,
    });
    await expect(assertInterviewCapacity(repository, { now: NOW, config })).rejects.toBeInstanceOf(CandidateDomainError);
  });

  it("ignores sessions that are abandoned, not started or already completed", async () => {
    const repository = repositoryWithSessions([
      { sessionId: 1, startedMinutesAgo: 120 },
      { sessionId: 2, status: "READY", startedMinutesAgo: 1 },
      { sessionId: 3, status: "COMPLETED", startedMinutesAgo: 1 },
      { sessionId: 4, startedMinutesAgo: 1 },
    ]);
    expect(repository.countActiveInterviewSessions(new Date(NOW.getTime() - 45 * 60_000))).toBe(1);
    await expect(assertInterviewCapacity(repository, { now: NOW, config })).resolves.toBeUndefined();
  });

  it("lets a candidate return to their own in-progress interview even when the limit is reached", async () => {
    const repository = repositoryWithSessions([
      { sessionId: 1, applicationId: 501, startedMinutesAgo: 5 },
      { sessionId: 2, applicationId: 502, startedMinutesAgo: 5 },
    ]);
    await expect(assertInterviewCapacity(repository, { applicationId: 501, now: NOW, config })).resolves.toBeUndefined();
    await expect(assertInterviewCapacity(repository, { applicationId: 503, now: NOW, config })).rejects.toMatchObject({
      code: "INTERVIEW_CAPACITY_EXCEEDED",
    });
  });
});
