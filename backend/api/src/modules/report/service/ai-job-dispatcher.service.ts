import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { CurrentUser } from "../../../common/dev-auth/current-user";
import { AI_JOB_QUEUE_PUBLISHER, AiJobQueuePublisher } from "./ai-job-queue.publisher";
import { REPORT_REPOSITORY, ReportRepository } from "../repository/report.repository";
import {
  AiProcessRefs,
  AiProcessType,
  EvaluationReportSnapshot,
  FailureReason,
  QueuedAiProcessSnapshot,
  ReportType
} from "../report.types";

export interface DispatchAiJobCommand {
  processType: AiProcessType;
  input: unknown;
  persistedInput?: unknown;
  refs?: AiProcessRefs;
}

export interface DispatchAiJobResult extends QueuedAiProcessSnapshot {
  queued: boolean;
}

export interface DispatchReportGenerationCommand {
  reportId: number;
  reportType: ReportType;
  input: unknown;
  refs?: AiProcessRefs;
  // 지정되면 리포트가 요청자 회사/지원자 소유인지 확인한다(ADMIN은 허용). 서비스 내부 호출처럼 이미 소유권을 확인한 경우만 생략한다.
  requester?: CurrentUser;
}

export interface DispatchReportGenerationResult extends DispatchAiJobResult {
  report: EvaluationReportSnapshot;
}

@Injectable()
export class AiJobDispatcherService {
  constructor(
    @Inject(REPORT_REPOSITORY) private readonly repository: ReportRepository,
    @Inject(AI_JOB_QUEUE_PUBLISHER) private readonly queuePublisher: AiJobQueuePublisher
  ) {}

  async dispatch(command: DispatchAiJobCommand): Promise<DispatchAiJobResult> {
    const queueInputRef = JSON.stringify(command.input);
    const persistedInputRef = JSON.stringify(command.persistedInput ?? command.input);
    const process = await this.repository.createQueuedProcess(command.processType, persistedInputRef, command.refs);

    if (process.idempotentReplay) {
      return { ...process, queued: true };
    }

    try {
      await this.queuePublisher.publish({
        processLogId: process.processLogId,
        processType: process.processType,
        inputRef: queueInputRef,
        attempt: 1
      });
    } catch {
      const failed = await this.repository.markQueuedProcessFailed(process.processLogId, this.queuePublishFailure());
      return {
        ...failed,
        queued: false
      };
    }

    return {
      ...process,
      queued: true
    };
  }

  async dispatchReportGeneration(command: DispatchReportGenerationCommand): Promise<DispatchReportGenerationResult> {
    if (command.requester) {
      await this.assertReportAccess(command.reportId, command.requester);
    }
    const report = await this.repository.markReportGenerating(command.reportId, command.reportType, command.refs);
    const process = await this.dispatch({
      processType: "REPORT_GENERATE",
      input: command.input,
      refs: command.refs
    });
    const finalReport =
      process.status === "FAILED" && process.failure
        ? await this.repository.markReportFailed(command.reportId, process.failure)
        : report;

    return {
      ...process,
      report: finalReport
    };
  }

  async assertReportAccess(reportId: number, requester: CurrentUser): Promise<void> {
    if (requester.userType === "ADMIN") return;

    const owner = await this.repository.getReportOwner(reportId);
    const allowed =
      owner !== null &&
      ((requester.userType === "COMPANY" && !!requester.companyId && owner.companyId === requester.companyId) ||
        (requester.userType === "CANDIDATE" && !!requester.candidateId && owner.candidateId === requester.candidateId));

    if (!allowed) {
      throw new ForbiddenException({
        code: "COMMON_FORBIDDEN",
        message: "Report access is not allowed."
      });
    }
  }

  private queuePublishFailure(): FailureReason {
    return {
      category: "RETRYABLE",
      reason: "AI queue publish failed.",
      retryable: true
    };
  }
}
