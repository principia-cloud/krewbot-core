/**
 * auth.ts — JWT authentication and membership validation.
 *
 * JWKS is still vended into /config/jwks.json by the sidecar (public
 * Cognito keys, no AWS creds needed). Members come from the Agent
 * Platform API — the sidecar no longer mirrors them.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import { jwtVerify, createLocalJWKSet, type JWTPayload } from "jose";
import { platformClient } from "./platform-client.js";
import { rootLogger, logCatch } from "./logger.js";

const JWKS_PATH = process.env.JWKS_PATH || "/config/jwks.json";
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID!;
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID!;
const AWS_REGION = process.env.AWS_REGION || "us-east-1";

const EXPECTED_ISSUER = `https://cognito-idp.${AWS_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}`;

// JWKS is mirrored from Cognito by the sidecar via atomic rename, which
// updates mtime on every successful sync. We cache the parsed structure and
// invalidate strictly on mtime change — no time-based TTL — so a sidecar
// refresh propagates to auth on the very next request.
let jwksCache: ReturnType<typeof createLocalJWKSet> | null = null;
let jwksMtimeMs = 0;

function loadJwks(): ReturnType<typeof createLocalJWKSet> | null {
  try {
    const stat = fs.statSync(JWKS_PATH);
    if (jwksCache && stat.mtimeMs === jwksMtimeMs) return jwksCache;
    const raw = fs.readFileSync(JWKS_PATH, "utf-8");
    jwksCache = createLocalJWKSet(JSON.parse(raw));
    jwksMtimeMs = stat.mtimeMs;
    return jwksCache;
  } catch (err) {
    // Falling back to the last good copy (if any) is the desired
    // behavior: a sidecar hiccup shouldn't break auth for running
    // tasks. Surface the event so we can alert on repeated failures.
    logCatch(rootLogger, "auth.jwks.refresh_failed", err, {
      path: JWKS_PATH,
      fallbackAvailable: jwksCache !== null,
    });
    return jwksCache;
  }
}

async function isMember(
  sub: string,
): Promise<{ ok: boolean; available: boolean; role: string }> {
  try {
    const members = await platformClient.getMembers();
    const m = members.find((x) => x.userId === sub);
    return { ok: !!m, available: true, role: m?.role || "member" };
  } catch (err) {
    logCatch(rootLogger, "auth.member.lookup_failed", err, { userId: sub });
    return { ok: false, available: false, role: "member" };
  }
}

export type AuthResult =
  | { ok: true; sub: string; role: string; claims: JWTPayload }
  | { ok: false; status: number; error: string };

export async function authenticate(req: http.IncomingMessage): Promise<AuthResult> {
  const auth = req.headers["authorization"] || req.headers["Authorization"];
  const header = Array.isArray(auth) ? auth[0] : auth;
  if (!header || !header.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Missing Bearer token" };
  }
  const token = header.slice("Bearer ".length).trim();

  const ks = loadJwks();
  if (!ks) {
    return { ok: false, status: 503, error: "JWKS not yet available" };
  }

  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, ks, {
      issuer: EXPECTED_ISSUER,
      audience: COGNITO_CLIENT_ID,
    });
    payload = result.payload;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    rootLogger.warn(
      { event: "auth.jwt.invalid", reason },
      "jwt verification failed",
    );
    return { ok: false, status: 401, error: `Invalid token: ${reason}` };
  }

  const sub = payload.sub;
  if (!sub) {
    return { ok: false, status: 401, error: "Token missing sub claim" };
  }

  const result = await isMember(sub);
  if (!result.available) {
    return { ok: false, status: 503, error: "Membership lookup unavailable" };
  }
  if (!result.ok) {
    return { ok: false, status: 403, error: "Not a member of this workspace" };
  }

  return { ok: true, sub, role: result.role, claims: payload };
}
