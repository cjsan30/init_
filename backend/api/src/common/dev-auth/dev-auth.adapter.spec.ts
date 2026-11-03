import { UnauthorizedException } from "@nestjs/common";
import { JwtAuthGuard } from "../../modules/auth/jwt-auth.guard";
import { isDevAuthEnvironment, isSwaggerEnabled } from "./dev-auth-env";
import { DevAuthAdapter } from "./dev-auth.adapter";

const forgedAdminHeaders = {
  "x-dev-user-id": "9",
  "x-dev-user-type": "ADMIN",
};

function guardContext(headers: Record<string, string>, url = "/api/v1/candidate/me") {
  const request: Record<string, unknown> = { headers, originalUrl: url };
  return {
    request,
    context: { switchToHttp: () => ({ getRequest: () => request }) } as never,
  };
}

describe("dev auth environment gate", () => {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    demoNoAuth: process.env.CANDIDATE_DEMO_NO_AUTH,
  };

  afterEach(() => {
    setNodeEnv(previous.nodeEnv);
    if (previous.demoNoAuth === undefined) {
      delete process.env.CANDIDATE_DEMO_NO_AUTH;
    } else {
      process.env.CANDIDATE_DEMO_NO_AUTH = previous.demoNoAuth;
    }
  });

  function setNodeEnv(value: string | undefined) {
    if (value === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = value;
    }
  }

  it.each(["local", "development", "test"])("enables dev auth for NODE_ENV=%s", (nodeEnv) => {
    expect(isDevAuthEnvironment({ NODE_ENV: nodeEnv })).toBe(true);
  });

  it.each([undefined, "", "production", "staging"])("fails closed for NODE_ENV=%p", (nodeEnv) => {
    expect(isDevAuthEnvironment({ NODE_ENV: nodeEnv })).toBe(false);
  });

  it.each([["production"], [undefined]])("DevAuthAdapter.parse rejects forged headers when NODE_ENV=%p", (nodeEnv) => {
    setNodeEnv(nodeEnv);
    expect(() => new DevAuthAdapter().parse(forgedAdminHeaders)).toThrow(UnauthorizedException);
  });

  it("DevAuthAdapter.resolve prefers the guard-provided currentUser", () => {
    setNodeEnv("production");
    const currentUser = new DevAuthAdapter().resolve({
      currentUser: { userId: 5, userType: "COMPANY", companyId: 3, candidateId: null },
      headers: forgedAdminHeaders,
    });
    expect(currentUser).toEqual({ userId: 5, userType: "COMPANY", companyId: 3 });
  });

  it("DevAuthAdapter.parse still accepts dev headers in test", () => {
    setNodeEnv("test");
    expect(new DevAuthAdapter().parse(forgedAdminHeaders)).toEqual({ userId: 9, userType: "ADMIN" });
  });

  it.each([["production"], [undefined]])("JwtAuthGuard ignores dev headers and demo no-auth when NODE_ENV=%p", (nodeEnv) => {
    setNodeEnv(nodeEnv);
    process.env.CANDIDATE_DEMO_NO_AUTH = "true";
    const { context, request } = guardContext(forgedAdminHeaders);

    expect(() => new JwtAuthGuard().canActivate(context)).toThrow();
    expect(request.currentUser).toBeUndefined();
  });

  it("JwtAuthGuard accepts dev headers in test", () => {
    setNodeEnv("test");
    const { context, request } = guardContext(forgedAdminHeaders);

    expect(new JwtAuthGuard().canActivate(context)).toBe(true);
    expect(request.currentUser).toMatchObject({ userId: 9, userType: "ADMIN" });
  });

  it("disables Swagger by default in production", () => {
    expect(isSwaggerEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(isSwaggerEnabled({})).toBe(false);
    expect(isSwaggerEnabled({ NODE_ENV: "production", ENABLE_SWAGGER: "true" })).toBe(true);
    expect(isSwaggerEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(isSwaggerEnabled({ NODE_ENV: "development", DISABLE_SWAGGER: "true" })).toBe(false);
  });
});
