import { Body, Controller, HttpCode, HttpException, HttpStatus, Inject, Post } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { randomUUID } from "node:crypto";
import { ApiErrorResponses, ApiOperationId } from "../../../swagger/swagger.decorators";
import { CandidateDomainError } from "../../candidate";
import { RealtimeUsageReportDto } from "../dto/interview.runtime.dto";
import { RealtimeUsageService } from "../service/realtime-usage.service";

// 음성 면접관은 브라우저가 OpenAI와 직접 연결하므로, 자격 증명 발급 때 받은 서명 token으로
// 로그인·public 면접 구분 없이 사용량을 보고한다. 인증은 token 검증으로 대신한다.
@ApiTags("Realtime Usage")
@ApiErrorResponses()
@Controller("realtime-usage")
export class RealtimeUsageController {
  constructor(@Inject(RealtimeUsageService) private readonly usage: RealtimeUsageService) {}

  @Post("reports")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperationId("API-AI-RT-001")
  @ApiOperation({ summary: "음성 면접관 Realtime 연결 사용량 보고" })
  @ApiResponse({ status: HttpStatus.ACCEPTED, description: "Realtime usage recorded" })
  async report(@Body() dto: RealtimeUsageReportDto) {
    try {
      const data = await this.usage.recordClientReport(dto);
      return { data, meta: { traceId: randomUUID(), timestamp: new Date().toISOString() } };
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
