import assert from "node:assert/strict";
import test from "node:test";

import { buildLoginRedirectPath, getLogoutRedirectPath, getRouteAccess, resolvePostLoginPath } from "./routePolicy";

test("company login is public even though it lives under the protected company prefix", () => {
  assert.deepEqual(getRouteAccess("/company/login"), { kind: "public" });
});

test("company application pages remain company-only", () => {
  assert.deepEqual(getRouteAccess("/company/applications/dashboard"), {
    kind: "protected",
    allowedUserTypes: ["COMPANY"],
    loginPath: "/company/login",
  });
});

test("company recruitment pages use the company login destination", () => {
  assert.deepEqual(getRouteAccess("/company/recruitments"), {
    kind: "protected",
    allowedUserTypes: ["COMPANY"],
    loginPath: "/company/login",
  });
});

test("nested company recruitment pages inherit the company login destination", () => {
  assert.deepEqual(getRouteAccess("/company/recruitments/42/settings"), {
    kind: "protected",
    allowedUserTypes: ["COMPANY"],
    loginPath: "/company/login",
  });
});

test("candidate pages remain candidate-only", () => {
  assert.deepEqual(getRouteAccess("/candidate/jobs"), {
    kind: "protected",
    allowedUserTypes: ["CANDIDATE"],
    loginPath: "/login",
  });
});

test("company logout returns to the public candidate job list", () => {
  assert.equal(getLogoutRedirectPath("COMPANY"), "/");
});

test("candidate logout keeps the candidate login destination", () => {
  assert.equal(getLogoutRedirectPath("CANDIDATE"), "/login");
});

test("job detail is viewable without login but keeps the candidate role", () => {
  assert.deepEqual(getRouteAccess("/candidate/jobs/12"), {
    kind: "optional",
    allowedUserTypes: ["CANDIDATE"],
    loginPath: "/login",
  });
  assert.equal(getRouteAccess("/candidate/jobs/12/apply").kind, "protected");
});

test("login redirect keeps the return path in next", () => {
  assert.equal(buildLoginRedirectPath("/login", "/candidate/jobs/12?apply=1"), "/login?next=%2Fcandidate%2Fjobs%2F12%3Fapply%3D1");
});

test("post-login path accepts only same-site paths for the logged-in role", () => {
  assert.equal(resolvePostLoginPath("/candidate/jobs/12?apply=1", "CANDIDATE"), "/candidate/jobs/12?apply=1");
  assert.equal(resolvePostLoginPath("/candidate/applications", "CANDIDATE"), "/candidate/applications");
  assert.equal(resolvePostLoginPath("/company/recruitments", "CANDIDATE"), "/candidate/jobs");
  assert.equal(resolvePostLoginPath("//evil.example.com", "CANDIDATE"), "/candidate/jobs");
  assert.equal(resolvePostLoginPath("https://evil.example.com", "COMPANY"), "/company/applications/dashboard");
  assert.equal(resolvePostLoginPath("/login", "CANDIDATE"), "/candidate/jobs");
  assert.equal(resolvePostLoginPath(null, "COMPANY"), "/company/applications/dashboard");
});
