import { ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { CurrentUser, UserType } from "./current-user";
import { isDevAuthEnvironment } from "./dev-auth-env";

type HeaderBag = Record<string, string | string[] | undefined>;

type RequestUser = {
  userId: number;
  userType: UserType;
  companyId?: number | null;
  candidateId?: number | null;
};

@Injectable()
export class DevAuthAdapter {
  // JwtAuthGuard가 넣은 request.currentUser를 우선 사용하고, 없을 때만 개발 환경 헤더로 대체한다.
  resolve(request: { currentUser?: RequestUser | null; headers?: HeaderBag }): CurrentUser {
    if (request.currentUser) {
      const currentUser: CurrentUser = {
        userId: request.currentUser.userId,
        userType: request.currentUser.userType,
      };
      if (request.currentUser.companyId) currentUser.companyId = request.currentUser.companyId;
      if (request.currentUser.candidateId) currentUser.candidateId = request.currentUser.candidateId;
      return currentUser;
    }
    return this.parse(request.headers ?? {});
  }

  parse(headers: HeaderBag): CurrentUser {
    if (!isDevAuthEnvironment()) {
      throw new UnauthorizedException({
        code: "COMMON_UNAUTHORIZED",
        message: "Authentication is required."
      });
    }

    const userId = this.numberHeader(headers, "x-dev-user-id");
    const userType = this.stringHeader(headers, "x-dev-user-type") as UserType | undefined;

    if (!userId || !userType) {
      throw new UnauthorizedException({
        code: "COMMON_UNAUTHORIZED",
        message: "Dev auth headers are required."
      });
    }

    if (!["ADMIN", "COMPANY", "CANDIDATE"].includes(userType)) {
      throw new ForbiddenException({
        code: "COMMON_FORBIDDEN",
        message: "Unsupported dev user type."
      });
    }

    const currentUser: CurrentUser = {
      userId,
      userType
    };

    const companyId = this.numberHeader(headers, "x-dev-company-id");
    const candidateId = this.numberHeader(headers, "x-dev-candidate-id");

    if (companyId) {
      currentUser.companyId = companyId;
    }

    if (candidateId) {
      currentUser.candidateId = candidateId;
    }

    return currentUser;
  }

  assertCompany(currentUser: CurrentUser): void {
    if (currentUser.userType !== "COMPANY" || !currentUser.companyId) {
      throw new ForbiddenException({
        code: "COMMON_FORBIDDEN",
        message: "Company user is required."
      });
    }
  }

  assertCandidate(currentUser: CurrentUser): void {
    if (currentUser.userType !== "CANDIDATE" || !currentUser.candidateId) {
      throw new ForbiddenException({
        code: "COMMON_FORBIDDEN",
        message: "Candidate user is required."
      });
    }
  }

  assertAdmin(currentUser: CurrentUser): void {
    if (currentUser.userType !== "ADMIN") {
      throw new ForbiddenException({
        code: "COMMON_FORBIDDEN",
        message: "Admin user is required."
      });
    }
  }

  private stringHeader(headers: HeaderBag, name: string): string | undefined {
    const value = headers[name] ?? headers[this.titleCaseHeader(name)];
    if (Array.isArray(value)) {
      return value[0];
    }
    return value;
  }

  private numberHeader(headers: HeaderBag, name: string): number | undefined {
    const value = this.stringHeader(headers, name);
    if (!value) {
      return undefined;
    }

    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }

  private titleCaseHeader(name: string): string {
    return name
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("-");
  }
}
