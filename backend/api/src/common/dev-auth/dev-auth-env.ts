const DEV_AUTH_ENVIRONMENTS = ["local", "development", "test"];

export const DEV_AUTH_HEADERS = ["X-Dev-User-Id", "X-Dev-User-Type", "X-Dev-Company-Id", "X-Dev-Candidate-Id"];

// NODE_ENV가 비어 있으면 운영으로 간주한다(fail closed). X-Dev-* 헤더 인증은 로컬/개발/테스트에서만 허용한다.
export function isDevAuthEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return DEV_AUTH_ENVIRONMENTS.includes(env.NODE_ENV ?? "");
}

// Swagger는 DISABLE_SWAGGER=true면 끄고, ENABLE_SWAGGER=true면 켜며, 그 외에는 개발 환경에서만 켠다.
export function isSwaggerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DISABLE_SWAGGER === "true") return false;
  if (env.ENABLE_SWAGGER === "true") return true;
  return isDevAuthEnvironment(env);
}
