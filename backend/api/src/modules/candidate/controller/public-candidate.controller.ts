import { Controller, Get, HttpException, Inject, Param, Query } from "@nestjs/common";
import { CandidateJobListQueryDto } from "../dto/candidate-job-list-query.dto";
import { publicCandidateApiRoutePrefix, publicCandidateApiRoutes } from "../candidate.routes";
import { CandidateDomainError } from "../candidate.errors";
import { CandidateService } from "../service/candidate.service";

@Controller(publicCandidateApiRoutePrefix)
export class PublicCandidateController {
  constructor(@Inject(CandidateService) private readonly candidateService: CandidateService) {}

  @Get(publicCandidateApiRoutes.jobs)
  listJobs(@Query() query: CandidateJobListQueryDto) {
    return this.candidateService.listJobs(query);
  }

  @Get(publicCandidateApiRoutes.jobDetail)
  getJobDetail(@Param("jobId") jobId: string) {
    return this.handle(() => this.candidateService.getPublicJobDetail(Number(jobId)));
  }

  private async handle<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof CandidateDomainError) {
        throw new HttpException(
          { code: error.code, message: error.message, details: error.details },
          error.statusCode,
        );
      }
      throw error;
    }
  }
}
