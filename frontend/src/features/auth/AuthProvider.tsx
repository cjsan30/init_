"use client";

import { usePathname, useRouter } from "next/navigation";
import { ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import {
  AUTH_SESSION_CLEARED_EVENT,
  AUTH_SESSION_CLEARED_STORAGE_KEY,
  AuthTokenResponse,
  AuthUser,
  broadcastAuthSessionCleared,
  fetchCurrentUser,
  getAccessToken,
  logoutAuthSession,
  refreshAuthSession,
  setAccessToken,
} from "../../api/client";
import {
  buildLoginRedirectPath,
  getRedirectForUnauthorizedRole,
  getRouteAccess,
  isAllowedUserType,
} from "./routePolicy";

type AuthStatus = "checking" | "authenticated" | "unauthenticated";

type AuthContextValue = {
  status: AuthStatus;
  user: AuthUser | null;
  completeLogin: (session: AuthTokenResponse) => void;
  clearSession: () => void;
  logout: () => Promise<void>;
  isExplicitLogout: () => boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("checking");
  const [user, setUser] = useState<AuthUser | null>(null);
  const sessionClearVersionRef = useRef(0);
  // 사용자가 직접 로그아웃한 경우 보호 화면 가드가 로그인 복귀 경로(next)를 붙이지 않게 한다.
  const explicitLogoutRef = useRef(false);
  const isExplicitLogout = useCallback(() => explicitLogoutRef.current, []);

  const clearSession = useCallback(() => {
    sessionClearVersionRef.current += 1;
    setAccessToken(null);
    broadcastAuthSessionCleared();
    setUser(null);
    setStatus("unauthenticated");
  }, []);

  const logout = useCallback(async () => {
    explicitLogoutRef.current = true;
    try {
      await logoutAuthSession();
    } catch {
      // Server cookie cleanup is best-effort; local auth state must still be cleared.
    } finally {
      clearSession();
    }
  }, [clearSession]);

  const completeLogin = useCallback((session: AuthTokenResponse) => {
    explicitLogoutRef.current = false;
    setAccessToken(session.accessToken);
    setUser(session.user);
    setStatus("authenticated");
  }, []);

  useEffect(() => {
    let canceled = false;

    async function restoreSession() {
      const restoreVersion = sessionClearVersionRef.current;

      try {
        const existingToken = getAccessToken();
        const session = existingToken ? { user: await fetchCurrentUser() } : await refreshAuthSession();
        if (canceled || sessionClearVersionRef.current !== restoreVersion) return;
        setUser(session.user);
        setStatus("authenticated");
      } catch {
        if (canceled || sessionClearVersionRef.current !== restoreVersion) return;
        setAccessToken(null);
        setUser(null);
        setStatus("unauthenticated");
      }
    }

    void restoreSession();

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    function handleSessionCleared() {
      sessionClearVersionRef.current += 1;
      setUser(null);
      setStatus("unauthenticated");
    }

    window.addEventListener(AUTH_SESSION_CLEARED_EVENT, handleSessionCleared);
    return () => window.removeEventListener(AUTH_SESSION_CLEARED_EVENT, handleSessionCleared);
  }, []);

  useEffect(() => {
    function handleCrossTabSessionCleared(event: StorageEvent) {
      if (event.key !== AUTH_SESSION_CLEARED_STORAGE_KEY || !event.newValue) return;

      sessionClearVersionRef.current += 1;
      setAccessToken(null);
      setUser(null);
      setStatus("unauthenticated");
    }

    window.addEventListener("storage", handleCrossTabSessionCleared);
    return () => window.removeEventListener("storage", handleCrossTabSessionCleared);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      completeLogin,
      clearSession: () => {
        clearSession();
      },
      logout,
      isExplicitLogout,
    }),
    [clearSession, completeLogin, isExplicitLogout, logout, status, user],
  );

  return (
    <AuthContext.Provider value={value}>
      <AuthRouteGuard>{children}</AuthRouteGuard>
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}

function AuthRouteGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { isExplicitLogout, status, user } = useAuth();
  const routeAccess = useMemo(() => getRouteAccess(pathname), [pathname]);

  useEffect(() => {
    if (status === "checking") return;

    if (routeAccess.kind === "protected" && status === "unauthenticated") {
      router.replace(
        isExplicitLogout()
          ? routeAccess.loginPath
          : buildLoginRedirectPath(routeAccess.loginPath, `${pathname}${window.location.search}`),
      );
      return;
    }

    if (
      (routeAccess.kind === "protected" || routeAccess.kind === "optional") &&
      status === "authenticated" &&
      user &&
      !isAllowedUserType(user.userType, routeAccess.allowedUserTypes)
    ) {
      router.replace(getRedirectForUnauthorizedRole(user.userType));
    }
  }, [isExplicitLogout, pathname, routeAccess, router, status, user]);

  if (routeAccess.kind !== "common" && status === "checking") {
    return null;
  }

  if (routeAccess.kind === "protected") {
    if (status !== "authenticated" || !user) return null;
    if (!isAllowedUserType(user.userType, routeAccess.allowedUserTypes)) return null;
  }

  if (routeAccess.kind === "optional" && status === "authenticated" && user) {
    if (!isAllowedUserType(user.userType, routeAccess.allowedUserTypes)) return null;
  }

  return children;
}
