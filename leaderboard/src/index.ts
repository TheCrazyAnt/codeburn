// CodeBurn leaderboard — Cloudflare Worker entry point.
// Implements API contract v1 (see API.md). Zero runtime dependencies.

import {
  LAST_USED_BUMP_MS,
  TOKEN_HEX_RE,
  bearerToken,
  fetchGitHubUser,
  newSessionToken,
  sha256Hex,
} from "./auth";
import { LEADERBOARD_HTML } from "./page";
import {
  MAX_APP_VERSION_LEN,
  evaluateReport,
  rateLimitRetryAfter,
  topProvider,
  utcMonth,
  validateReport,
  MONTH_RE,
} from "./rules";

export interface Env {
  DB: D1Database;
  GITHUB_CLIENT_ID: string;
  UPLOAD_INTERVAL_MINUTES: string;
  MIN_APP_VERSION: string;
}

const MAX_BODY_BYTES = 16 * 1024;
const REPORTS_KEEP_PER_USER = 500;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" } as const;
const NO_STORE = { "Cache-Control": "no-store" } as const;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...NO_STORE, ...headers },
  });
}

function error(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ error: code, message, ...extra }, status);
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
  toResponse(): Response {
    return error(this.status, this.code, this.message, this.extra);
  }
}

/** Parse a JSON body with a hard 16 KB cap. */
async function readJsonBody(request: Request): Promise<unknown> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new HttpError(413, "payload_too_large", `request body must be at most ${MAX_BODY_BYTES} bytes`);
  }
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "payload_too_large", `request body must be at most ${MAX_BODY_BYTES} bytes`);
  }
  if (buf.byteLength === 0) {
    throw new HttpError(400, "invalid_json", "request body must be a JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new HttpError(400, "invalid_json", "request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid_body", "request body must be a JSON object");
  }
  return parsed;
}

interface UserRow {
  id: number;
  login: string;
  avatar_url: string | null;
  lifetime_usd: number;
  lifetime_tokens: number;
  lifetime_calls: number;
  top_provider: string | null;
  flagged: number;
  opt_out: number;
  app_version: string | null;
  created_at: string;
  last_report_at: string | null;
}

interface AuthContext {
  user: UserRow;
  tokenHash: string;
}

/**
 * Resolve the bearer session token.
 * - no Authorization header → null
 * - malformed / unknown / revoked token → HttpError 401 unauthorized
 */
async function authenticate(request: Request, env: Env, nowMs: number): Promise<AuthContext | null> {
  const token = bearerToken(request);
  if (token === null) return null;
  if (!TOKEN_HEX_RE.test(token)) throw new HttpError(401, "unauthorized", "missing or invalid session token");

  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT s.last_used_at AS last_used_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?1`,
  )
    .bind(tokenHash)
    .first<UserRow & { last_used_at: string | null }>();
  if (!row) throw new HttpError(401, "unauthorized", "missing or invalid session token");

  const lastUsed = row.last_used_at ? Date.parse(row.last_used_at) : NaN;
  if (Number.isNaN(lastUsed) || nowMs - lastUsed >= LAST_USED_BUMP_MS) {
    await env.DB.prepare(`UPDATE sessions SET last_used_at = ?1 WHERE token_hash = ?2`)
      .bind(new Date(nowMs).toISOString(), tokenHash)
      .run();
  }
  const { last_used_at: _ignored, ...user } = row;
  return { user, tokenHash };
}

async function requireAuth(request: Request, env: Env, nowMs: number): Promise<AuthContext> {
  const ctx = await authenticate(request, env, nowMs);
  if (!ctx) throw new HttpError(401, "unauthorized", "missing or invalid session token");
  return ctx;
}

// ---------------------------------------------------------------------------
// Rank helpers (visible = not flagged, not opted out)
// ---------------------------------------------------------------------------

async function monthRank(env: Env, month: string, userId: number, usd: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n
       FROM monthly m JOIN users u ON u.id = m.user_id
      WHERE m.month = ?1 AND u.flagged = 0 AND u.opt_out = 0 AND u.id != ?2 AND m.usd > ?3`,
  )
    .bind(month, userId, usd)
    .first<{ n: number }>();
  return (row?.n ?? 0) + 1;
}

async function lifetimeRank(env: Env, userId: number, usd: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n
       FROM users
      WHERE flagged = 0 AND opt_out = 0 AND last_report_at IS NOT NULL AND id != ?1 AND lifetime_usd > ?2`,
  )
    .bind(userId, usd)
    .first<{ n: number }>();
  return (row?.n ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleConfig(env: Env, nowMs: number): Response {
  const interval = Number.parseInt(env.UPLOAD_INTERVAL_MINUTES, 10);
  return json(
    {
      githubClientId: env.GITHUB_CLIENT_ID,
      uploadIntervalMinutes: Number.isFinite(interval) && interval > 0 ? interval : 60,
      minAppVersion: env.MIN_APP_VERSION,
      board: { month: utcMonth(nowMs) },
    },
    200,
    { "Cache-Control": "public, max-age=300" },
  );
}

async function handleSession(request: Request, env: Env, nowMs: number): Promise<Response> {
  const body = (await readJsonBody(request)) as Record<string, unknown>;
  const accessToken = body.githubAccessToken;
  if (typeof accessToken !== "string" || accessToken.trim().length === 0 || accessToken.length > 512) {
    throw new HttpError(400, "invalid_field", "githubAccessToken must be a non-empty string");
  }
  if (/[\r\n\s]/.test(accessToken)) {
    throw new HttpError(400, "invalid_field", "githubAccessToken contains whitespace");
  }
  const appVersion = body.appVersion;
  if (typeof appVersion !== "string" || appVersion.length === 0 || appVersion.length > MAX_APP_VERSION_LEN) {
    throw new HttpError(400, "invalid_field", `appVersion must be a non-empty string (max ${MAX_APP_VERSION_LEN} chars)`);
  }

  const lookup = await fetchGitHubUser(accessToken);
  if (lookup.status === "invalid") {
    throw new HttpError(401, "github_token_invalid", "GitHub rejected the access token");
  }
  if (lookup.status === "unavailable") {
    throw new HttpError(502, "github_unavailable", `could not verify token with GitHub (${lookup.detail})`);
  }
  const gh = lookup.user;

  const now = new Date(nowMs).toISOString();
  const token = newSessionToken();
  const tokenHash = await sha256Hex(token);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, login, avatar_url, app_version, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(id) DO UPDATE SET
         login = excluded.login,
         avatar_url = excluded.avatar_url,
         app_version = excluded.app_version`,
    ).bind(gh.id, gh.login, gh.avatar_url, appVersion, now),
    env.DB.prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, last_used_at) VALUES (?1, ?2, ?3, ?3)`,
    ).bind(tokenHash, gh.id, now),
  ]);

  return json({
    sessionToken: token,
    user: { id: gh.id, login: gh.login, avatarUrl: gh.avatar_url },
  });
}

async function handleReport(request: Request, env: Env, nowMs: number): Promise<Response> {
  const { user } = await requireAuth(request, env, nowMs);
  const body = await readJsonBody(request);

  const validated = validateReport(body, nowMs);
  if (!validated.ok) throw new HttpError(400, "invalid_field", validated.message);
  const report = validated.report;

  // Rate limit: one accepted report per user per 10 minutes.
  const lastReportAtMs = user.last_report_at ? Date.parse(user.last_report_at) : null;
  const retryAfter = rateLimitRetryAfter(Number.isNaN(lastReportAtMs) ? null : lastReportAtMs, nowMs);
  if (retryAfter > 0) {
    return json(
      {
        error: "rate_limited",
        message: `one report per 10 minutes; retry in ${retryAfter}s`,
        retryAfterSeconds: retryAfter,
      },
      429,
      { "Retry-After": String(retryAfter) },
    );
  }

  const previous =
    lastReportAtMs !== null && !Number.isNaN(lastReportAtMs)
      ? { lifetimeUsd: user.lifetime_usd, lastReportAtMs }
      : null;
  const evaluation = evaluateReport(report, previous, nowMs);
  if (evaluation.verdict === "reject") {
    throw new HttpError(422, "implausible", evaluation.message);
  }

  const now = new Date(nowMs).toISOString();
  const flaggedNow = evaluation.flagged ? 1 : 0;
  const monthTop = topProvider(report.byProvider, "monthUSD");
  const lifetimeTop = topProvider(report.byProvider, "lifetimeUSD");

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users
          SET lifetime_usd = ?1, lifetime_tokens = ?2, lifetime_calls = ?3, top_provider = ?4,
              flagged = MAX(flagged, ?5), app_version = ?6, last_report_at = ?7
        WHERE id = ?8`,
    ).bind(
      report.lifetimeUSD,
      report.lifetimeTokens,
      report.lifetimeCalls,
      lifetimeTop,
      flaggedNow,
      report.appVersion,
      now,
      user.id,
    ),
    env.DB.prepare(
      `INSERT INTO monthly (user_id, month, usd, tokens, calls, top_provider, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(user_id, month) DO UPDATE SET
         usd = excluded.usd, tokens = excluded.tokens, calls = excluded.calls,
         top_provider = excluded.top_provider, updated_at = excluded.updated_at`,
    ).bind(user.id, report.month, report.monthUSD, report.monthTokens, report.monthCalls, monthTop, now),
    env.DB.prepare(
      `INSERT INTO reports (user_id, received_at, month, month_usd, lifetime_usd, flagged)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(user.id, now, report.month, report.monthUSD, report.lifetimeUSD, flaggedNow),
    env.DB.prepare(
      `DELETE FROM reports
        WHERE user_id = ?1
          AND id NOT IN (SELECT id FROM reports WHERE user_id = ?1 ORDER BY id DESC LIMIT ?2)`,
    ).bind(user.id, REPORTS_KEEP_PER_USER),
  ]);

  const flagged = user.flagged === 1 || flaggedNow === 1;
  const [rankMonth, rankLifetime] = await Promise.all([
    monthRank(env, report.month, user.id, report.monthUSD),
    lifetimeRank(env, user.id, report.lifetimeUSD),
  ]);

  return json({
    ok: true,
    flagged,
    ...(evaluation.reasons.length ? { flagReasons: evaluation.reasons } : {}),
    rank: { month: rankMonth, lifetime: rankLifetime },
  });
}

interface BoardEntry {
  rank: number;
  login: string;
  avatarUrl: string | null;
  usd: number;
  tokens: number;
  calls: number;
  topProvider: string | null;
}

const CORS_PUBLIC_GET = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin, Authorization",
} as const;

async function handleLeaderboard(request: Request, env: Env, url: URL, nowMs: number): Promise<Response> {
  const boardParam = url.searchParams.get("board") ?? "month";
  if (boardParam !== "month" && boardParam !== "lifetime") {
    throw new HttpError(400, "invalid_query", "board must be 'month' or 'lifetime'");
  }
  const limitParam = url.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    if (!/^\d{1,3}$/.test(limitParam)) throw new HttpError(400, "invalid_query", "limit must be an integer 1..100");
    limit = Number.parseInt(limitParam, 10);
    if (limit < 1 || limit > MAX_LIMIT) throw new HttpError(400, "invalid_query", "limit must be an integer 1..100");
  }
  const monthParam = url.searchParams.get("month");
  const month = monthParam ?? utcMonth(nowMs);
  if (monthParam !== null && !MONTH_RE.test(monthParam)) {
    throw new HttpError(400, "invalid_query", "month must be formatted YYYY-MM");
  }

  const auth = await authenticate(request, env, nowMs);

  let entries: BoardEntry[];
  let totalUsers: number;
  let updatedAt: string | null;
  let me: { rank: number; usd: number; tokens: number; calls: number; flagged: boolean } | null = null;

  if (boardParam === "month") {
    const rows = await env.DB.prepare(
      `SELECT u.login, u.avatar_url, m.usd, m.tokens, m.calls, m.top_provider
         FROM monthly m JOIN users u ON u.id = m.user_id
        WHERE m.month = ?1 AND u.flagged = 0 AND u.opt_out = 0
        ORDER BY m.usd DESC, m.tokens DESC, u.id ASC
        LIMIT ?2`,
    )
      .bind(month, limit)
      .all<{ login: string; avatar_url: string | null; usd: number; tokens: number; calls: number; top_provider: string | null }>();
    entries = rows.results.map((r, i) => ({
      rank: i + 1,
      login: r.login,
      avatarUrl: r.avatar_url,
      usd: r.usd,
      tokens: r.tokens,
      calls: r.calls,
      topProvider: r.top_provider,
    }));
    const agg = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MAX(m.updated_at) AS updated_at
         FROM monthly m JOIN users u ON u.id = m.user_id
        WHERE m.month = ?1 AND u.flagged = 0 AND u.opt_out = 0`,
    )
      .bind(month)
      .first<{ n: number; updated_at: string | null }>();
    totalUsers = agg?.n ?? 0;
    updatedAt = agg?.updated_at ?? null;

    if (auth) {
      const mine = await env.DB.prepare(
        `SELECT usd, tokens, calls FROM monthly WHERE user_id = ?1 AND month = ?2`,
      )
        .bind(auth.user.id, month)
        .first<{ usd: number; tokens: number; calls: number }>();
      if (mine) {
        me = {
          rank: await monthRank(env, month, auth.user.id, mine.usd),
          usd: mine.usd,
          tokens: mine.tokens,
          calls: mine.calls,
          flagged: auth.user.flagged === 1,
        };
      }
    }
  } else {
    const rows = await env.DB.prepare(
      `SELECT login, avatar_url, lifetime_usd, lifetime_tokens, lifetime_calls, top_provider
         FROM users
        WHERE flagged = 0 AND opt_out = 0 AND last_report_at IS NOT NULL
        ORDER BY lifetime_usd DESC, lifetime_tokens DESC, id ASC
        LIMIT ?1`,
    )
      .bind(limit)
      .all<{ login: string; avatar_url: string | null; lifetime_usd: number; lifetime_tokens: number; lifetime_calls: number; top_provider: string | null }>();
    entries = rows.results.map((r, i) => ({
      rank: i + 1,
      login: r.login,
      avatarUrl: r.avatar_url,
      usd: r.lifetime_usd,
      tokens: r.lifetime_tokens,
      calls: r.lifetime_calls,
      topProvider: r.top_provider,
    }));
    const agg = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MAX(last_report_at) AS updated_at
         FROM users WHERE flagged = 0 AND opt_out = 0 AND last_report_at IS NOT NULL`,
    ).first<{ n: number; updated_at: string | null }>();
    totalUsers = agg?.n ?? 0;
    updatedAt = agg?.updated_at ?? null;

    if (auth && auth.user.last_report_at) {
      me = {
        rank: await lifetimeRank(env, auth.user.id, auth.user.lifetime_usd),
        usd: auth.user.lifetime_usd,
        tokens: auth.user.lifetime_tokens,
        calls: auth.user.lifetime_calls,
        flagged: auth.user.flagged === 1,
      };
    }
  }

  const cache = auth ? "private, no-store" : "public, max-age=60";
  return json(
    {
      board: boardParam,
      month,
      updatedAt: updatedAt ?? new Date(nowMs).toISOString(),
      totalUsers,
      entries,
      me,
    },
    200,
    { ...CORS_PUBLIC_GET, "Cache-Control": cache },
  );
}

async function handleDeleteMe(request: Request, env: Env, nowMs: number): Promise<Response> {
  const { user } = await requireAuth(request, env, nowMs);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?1`).bind(user.id),
    env.DB.prepare(`DELETE FROM monthly WHERE user_id = ?1`).bind(user.id),
    env.DB.prepare(`DELETE FROM reports WHERE user_id = ?1`).bind(user.id),
    env.DB.prepare(`DELETE FROM users WHERE id = ?1`).bind(user.id),
  ]);
  return new Response(null, { status: 204, headers: NO_STORE });
}

async function handleLogout(request: Request, env: Env, nowMs: number): Promise<Response> {
  const { tokenHash } = await requireAuth(request, env, nowMs);
  await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?1`).bind(tokenHash).run();
  return new Response(null, { status: 204, headers: NO_STORE });
}

function handlePage(): Response {
  return new Response(LEADERBOARD_HTML, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https://avatars.githubusercontent.com https://*.githubusercontent.com; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();
  const nowMs = Date.now();

  switch (path) {
    case "/":
      if (method === "GET" || method === "HEAD") return handlePage();
      return methodNotAllowed("GET");
    case "/healthz":
      if (method === "GET" || method === "HEAD") {
        return new Response("ok", { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE } });
      }
      return methodNotAllowed("GET");
    case "/v1/config":
      if (method === "GET") return handleConfig(env, nowMs);
      return methodNotAllowed("GET");
    case "/v1/session":
      if (method === "POST") return handleSession(request, env, nowMs);
      return methodNotAllowed("POST");
    case "/v1/report":
      if (method === "POST") return handleReport(request, env, nowMs);
      return methodNotAllowed("POST");
    case "/v1/leaderboard":
      if (method === "GET") return handleLeaderboard(request, env, url, nowMs);
      if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_PUBLIC_GET });
      return methodNotAllowed("GET, OPTIONS");
    case "/v1/me":
      if (method === "DELETE") return handleDeleteMe(request, env, nowMs);
      return methodNotAllowed("DELETE");
    case "/v1/logout":
      if (method === "POST") return handleLogout(request, env, nowMs);
      return methodNotAllowed("POST");
    default:
      return error(404, "not_found", `no route for ${method} ${path}`);
  }
}

function methodNotAllowed(allow: string): Response {
  return json({ error: "method_not_allowed", message: `allowed: ${allow}` }, 405, { Allow: allow });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) return err.toResponse();
      console.error("unhandled error", err);
      return error(500, "internal", "internal server error");
    }
  },
} satisfies ExportedHandler<Env>;
