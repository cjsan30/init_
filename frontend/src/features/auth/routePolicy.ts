import { AuthUserType, UserType, getDefaultEntryPath } from "../../api/client";

type LoginPath = "/login" | "/company/login";

export type RouteAccess =
  | { kind: "common" }
  | { kind: "public" }
  | { kind: "optional"; allowedUserTypes: UserType[]; loginPath: LoginPath }
  | { kind: "protected"; allowedUserTypes: UserType[]; loginPath: LoginPath };

const publicRoutes = ["/", "/login", "/company/login", "/signup", "/password/reset", "/public"] as const;
const protectedRoutePrefixes: Array<{ prefix: string; allowedUserTypes: UserType[]; loginPath: LoginPath }> = [
  { prefix: "/company", allowedUserTypes: ["COMPANY"], loginPath: "/company/login" },
  { prefix: "/candidate", allowedUserTypes: ["CANDIDATE"], loginPath: "/login" },
];
// 비로그인 방문자도 볼 수 있지만 로그인 시 해당 역할로 동작하는 화면(공고 상세 API-059A).
const optionalRoutePatterns: Array<{ pattern: RegExp; allowedUserTypes: UserType[]; loginPath: LoginPath }> = [
  { pattern: /^\/candidate\/jobs\/\d+$/, allowedUserTypes: ["CANDIDATE"], loginPath: "/login" },
];

export function getRouteAccess(pathname: string): RouteAccess {
  const publicRoute = publicRoutes.find((route) => isRouteOrChild(pathname, route));
  if (publicRoute) return { kind: "public" };

  const optionalRoute = optionalRoutePatterns.find(({ pattern }) => pattern.test(pathname));
  if (optionalRoute) {
    return { kind: "optional", allowedUserTypes: optionalRoute.allowedUserTypes, loginPath: optionalRoute.loginPath };
  }

  const protectedRoute = protectedRoutePrefixes.find(({ prefix }) => isRouteOrChild(pathname, prefix));
  if (protectedRoute) {
    return {
      kind: "protected",
      allowedUserTypes: protectedRoute.allowedUserTypes,
      loginPath: protectedRoute.loginPath,
    };
  }

  return { kind: "common" };
}

export function getRedirectForAuthenticatedPublicRoute(userType: AuthUserType) {
  return getDefaultEntryPath(userType);
}

export function getRedirectForUnauthorizedRole(userType: AuthUserType) {
  return getDefaultEntryPath(userType);
}

export function getLogoutRedirectPath(userType?: AuthUserType | null) {
  return userType === "COMPANY" ? "/" : "/login";
}

// Google OAuth는 외부 왕복이라 next를 sessionStorage로 넘긴다.
export const POST_LOGIN_NEXT_STORAGE_KEY = "init.auth.postLoginNext";

export function buildLoginRedirectPath(loginPath: LoginPath, returnPath: string) {
  return `${loginPath}?next=${encodeURIComponent(returnPath)}`;
}

// 로그인 후 복귀 경로. 외부 URL·로그인 화면·다른 역할 화면이면 기본 진입 경로로 보낸다.
export function resolvePostLoginPath(next: string | null | undefined, userType: AuthUserType) {
  const fallback = getDefaultEntryPath(userType);
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;

  const pathname = next.split(/[?#]/)[0];
  const access = getRouteAccess(pathname);
  if (access.kind === "public") return fallback;
  if (access.kind !== "common" && !isAllowedUserType(userType, access.allowedUserTypes)) return fallback;
  return next;
}

export function isAllowedUserType(userType: AuthUserType, allowedUserTypes: UserType[]) {
  return allowedUserTypes.includes(userType as UserType);
}

function isRouteOrChild(pathname: string, route: string) {
  if (route === "/") return pathname === "/";
  return pathname === route || pathname.startsWith(`${route}/`);
}
