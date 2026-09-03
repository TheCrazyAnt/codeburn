// End-to-end tests: the Worker runs inside workerd (vitest-pool-workers) with a
// real (local) D1 database. Outbound calls to api.github.com are intercepted by
// stubbing the global fetch (the Worker under test shares this isolate).
import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { utcIsoWeek, utcMonth } from "../src/rules";

const BASE = "https://leaderboard.test";
const MONTH = utcMonth(Date.now());
const WEEK = utcIsoWeek(Date.now());

interface GhUser {
  id: number;
  login: string;
  avatar_url?: string;
}

const OCTOCAT: GhUser = { id: 583231, login: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4" };
const HUBOT: GhUser = { id: 480938, login: "hubot", avatar_url: "https://avatars.githubusercontent.com/u/480938?v=4" };
const MONA: GhUser = { id: 1, login: "mona", avatar_url: "https://avatars.githubusercontent.com/u/1?v=4" };

// ---------------------------------------------------------------------------
// GitHub stub: a FIFO of canned responses for GET https://api.github.com/user
// ---------------------------------------------------------------------------

interface GhReply {
  status: number;
  body: unknown;
  expectToken?: string;
}
const githubQueue: GhReply[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  githubQueue.length = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    if (req.url !== "https://api.github.com/user") {
      throw new Error(`unexpected outbound fetch: ${req.method} ${req.url}`);
    }
    const next = githubQueue.shift();
    if (!next) throw new Error("unexpected call to GitHub: no canned reply queued");
    expect(req.method).toBe("GET");
    expect(req.headers.get("user-agent")).toBe("codeburn-leaderboard");
    expect(req.headers.get("accept")).toBe("application/vnd.github+json");
    if (next.expectToken) expect(req.headers.get("authorization")).toBe(`Bearer ${next.expectToken}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(globalThis.fetch).toBe(realFetch);
  // every canned GitHub reply must have been consumed
  expect(githubQueue).toEqual([]);
});

/** Arrange a single GitHub /user response for the next session exchange. */
function mockGitHub(status: number, body: unknown, expectToken?: string) {
  githubQueue.push({ status, body, expectToken });
}

async function signIn(user: GhUser, appVersion = "0.9.23-zh4"): Promise<string> {
  const ghToken = `gho_${user.login}_${Math.random().toString(36).slice(2)}`;
  mockGitHub(200, user, ghToken);
  const res = await SELF.fetch(`${BASE}/v1/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ githubAccessToken: ghToken, appVersion }),
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { sessionToken: string; user: { id: number; login: string } };
  expect(data.user.id).toBe(user.id);
  return data.sessionToken;
}

function reportBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    month: MONTH,
    monthUSD: 620.5,
    monthTokens: 20_000_000,
    monthCalls: 900,
    lifetimeUSD: 3100.25,
    lifetimeTokens: 120_000_000,
    lifetimeCalls: 5000,
    byProvider: [
      { id: "claude", monthUSD: 600, lifetimeUSD: 2000 },
      { id: "codex", monthUSD: 20.5, lifetimeUSD: 1100.25 },
    ],
    appVersion: "0.9.23-zh4",
    reportedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function postReport(token: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return SELF.fetch(`${BASE}/v1/report`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function getBoard(query: string, token?: string): Promise<{ status: number; data: any }> {
  const res = await SELF.fetch(`${BASE}/v1/leaderboard${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, data: res.status === 204 ? null : await res.json() };
}

/** Backdate the user's last report so rate-limit / growth-cap windows can be exercised. */
async function backdateLastReport(userId: number, ms: number) {
  await env.DB.prepare(`UPDATE users SET last_report_at = ?1 WHERE id = ?2`)
    .bind(new Date(Date.now() - ms).toISOString(), userId)
    .run();
}

// ---------------------------------------------------------------------------

describe("basics", () => {
  it("GET /healthz → ok", async () => {
    const res = await SELF.fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("GET /v1/config exposes vars and the current UTC week and month", async () => {
    const res = await SELF.fetch(`${BASE}/v1/config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      githubClientId: env.GITHUB_CLIENT_ID,
      uploadIntervalMinutes: 60,
      minAppVersion: "0.9.23",
      board: { week: WEEK, month: MONTH },
    });
    expect(WEEK).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("GET / serves the Chinese HTML page with no external scripts", async () => {
    const res = await SELF.fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('lang="zh-CN"');
    expect(html).toContain("本周");
    expect(html).toContain("本月");
    expect(html).toContain("累计");
    expect(html.indexOf('data-board="week"')).toBeLessThan(html.indexOf('data-board="month"'));
    // metric toggle: 产出 (default) / 花费 / 活跃
    expect(html).toContain('data-metric="output"');
    expect(html).toContain('data-metric="usd"');
    expect(html).toContain('data-metric="streak"');
    expect(html).toMatch(/id="metric-output" aria-selected="true"/);
    expect(html).toContain("&metric=");
    expect(html).toContain("https://github.com/TheCrazyAnt/codeburn");
    expect(html).toContain("/v1/leaderboard?board=");
    expect(html).not.toMatch(/<script[^>]*src=/);
    expect(html).not.toMatch(/<link[^>]*href=/);
  });

  it("unknown routes → 404 JSON, wrong method → 405", async () => {
    const nf = await SELF.fetch(`${BASE}/nope`);
    expect(nf.status).toBe(404);
    expect(await nf.json()).toMatchObject({ error: "not_found" });
    const mna = await SELF.fetch(`${BASE}/v1/config`, { method: "POST" });
    expect(mna.status).toBe(405);
  });

  it("CORS: only GET /v1/leaderboard is open to other origins", async () => {
    const pre = await SELF.fetch(`${BASE}/v1/leaderboard`, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-methods")).toContain("GET");
    expect(pre.headers.get("access-control-allow-headers")).toBeNull();
    const board = await SELF.fetch(`${BASE}/v1/leaderboard`);
    expect(board.headers.get("access-control-allow-origin")).toBe("*");
    const cfg = await SELF.fetch(`${BASE}/v1/config`);
    expect(cfg.headers.get("access-control-allow-origin")).toBeNull();
    const rep = await SELF.fetch(`${BASE}/v1/report`, { method: "OPTIONS" });
    expect(rep.status).toBe(405);
    expect(rep.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("POST /v1/session", () => {
  it("exchanges a valid GitHub token for a session (hash stored, not the token)", async () => {
    const token = await signIn(OCTOCAT);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const rows = await env.DB.prepare(`SELECT token_hash, user_id FROM sessions`).all<{ token_hash: string; user_id: number }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].user_id).toBe(OCTOCAT.id);
    expect(rows.results[0].token_hash).not.toBe(token);
    expect(rows.results[0].token_hash).toMatch(/^[0-9a-f]{64}$/);

    const user = await env.DB.prepare(`SELECT * FROM users WHERE id = ?1`).bind(OCTOCAT.id).first<any>();
    expect(user.login).toBe("octocat");
    expect(user.avatar_url).toBe(OCTOCAT.avatar_url);
    expect(user.app_version).toBe("0.9.23-zh4");
  });

  it("returns the contract-shaped response", async () => {
    mockGitHub(200, OCTOCAT, "gho_abc");
    const res = await SELF.fetch(`${BASE}/v1/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ githubAccessToken: "gho_abc", appVersion: "0.9.23" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const data: any = await res.json();
    expect(data).toEqual({
      sessionToken: expect.stringMatching(/^[0-9a-f]{64}$/),
      user: { id: OCTOCAT.id, login: "octocat", avatarUrl: OCTOCAT.avatar_url },
    });
  });

  it("second sign-in for the same GitHub user refreshes profile and adds a session (one account per user)", async () => {
    await signIn(OCTOCAT);
    mockGitHub(200, { ...OCTOCAT, login: "octocat-renamed" }, "gho_two");
    const res = await SELF.fetch(`${BASE}/v1/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ githubAccessToken: "gho_two", appVersion: "0.9.24" }),
    });
    expect(res.status).toBe(200);
    const users = await env.DB.prepare(`SELECT id, login FROM users`).all<{ id: number; login: string }>();
    expect(users.results).toEqual([{ id: OCTOCAT.id, login: "octocat-renamed" }]);
    const sessions = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sessions`).first<{ n: number }>();
    expect(sessions?.n).toBe(2);
  });

  it("401 github_token_invalid when GitHub rejects the token", async () => {
    mockGitHub(401, { message: "Bad credentials" });
    const res = await SELF.fetch(`${BASE}/v1/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ githubAccessToken: "gho_bad", appVersion: "0.9.23" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "github_token_invalid" });
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("502 github_unavailable when GitHub is down", async () => {
    mockGitHub(503, { message: "nope" });
    const res = await SELF.fetch(`${BASE}/v1/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ githubAccessToken: "gho_x", appVersion: "0.9.23" }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "github_unavailable" });
  });

  it("400 on bad bodies (no GitHub call made)", async () => {
    const post = (body: string, headers: Record<string, string> = {}) =>
      SELF.fetch(`${BASE}/v1/session`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });

    expect((await post("{not json")).status).toBe(400);
    expect(await (await post("[]")).json()).toMatchObject({ error: "invalid_body" });
    expect(await (await post(JSON.stringify({ appVersion: "1" }))).json()).toMatchObject({ error: "invalid_field" });
    expect(await (await post(JSON.stringify({ githubAccessToken: "gho_x" }))).json()).toMatchObject({ error: "invalid_field" });
    expect(await (await post(JSON.stringify({ githubAccessToken: "", appVersion: "1" }))).json()).toMatchObject({ error: "invalid_field" });

    const big = JSON.stringify({ githubAccessToken: "gho_x", appVersion: "1", pad: "x".repeat(17_000) });
    const tooBig = await post(big);
    expect(tooBig.status).toBe(413);
    expect(await tooBig.json()).toMatchObject({ error: "payload_too_large" });
  });
});

describe("auth", () => {
  it("401 unauthorized for missing, malformed, unknown and revoked tokens", async () => {
    expect((await postReport(null, reportBody())).status).toBe(401);
    expect(await (await postReport(null, reportBody())).json()).toMatchObject({ error: "unauthorized" });
    expect((await postReport("not-a-token", reportBody())).status).toBe(401);
    expect((await postReport("f".repeat(64), reportBody())).status).toBe(401);

    const token = await signIn(OCTOCAT);
    const logout = await SELF.fetch(`${BASE}/v1/logout`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    expect(logout.status).toBe(204);
    expect((await postReport(token, reportBody())).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/v1/logout`, { method: "POST", headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it("logout revokes only the current session", async () => {
    const t1 = await signIn(OCTOCAT);
    const t2 = await signIn(OCTOCAT);
    const res = await SELF.fetch(`${BASE}/v1/logout`, { method: "POST", headers: { Authorization: `Bearer ${t1}` } });
    expect(res.status).toBe(204);
    expect((await postReport(t1, reportBody())).status).toBe(401);
    expect((await postReport(t2, reportBody())).status).toBe(200);
  });

  it("bumps sessions.last_used_at at most once per hour", async () => {
    const token = await signIn(OCTOCAT);
    const stale = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await env.DB.prepare(`UPDATE sessions SET last_used_at = ?1`).bind(stale).run();

    await postReport(token, reportBody());
    const after1 = (await env.DB.prepare(`SELECT last_used_at FROM sessions`).first<{ last_used_at: string }>())!.last_used_at;
    expect(after1).not.toBe(stale);
    expect(Date.now() - Date.parse(after1)).toBeLessThan(60_000);

    const recent = new Date(Date.now() - 10 * 60_000).toISOString();
    await env.DB.prepare(`UPDATE sessions SET last_used_at = ?1`).bind(recent).run();
    await getBoard("?board=month", token);
    const after2 = (await env.DB.prepare(`SELECT last_used_at FROM sessions`).first<{ last_used_at: string }>())!.last_used_at;
    expect(after2).toBe(recent);
  });
});

describe("POST /v1/report", () => {
  it("accepts a plausible first report and stores users / monthly / reports", async () => {
    const token = await signIn(OCTOCAT);
    const res = await postReport(token, reportBody());
    expect(res.status).toBe(200);
    // no week fields sent → no weekly row, rank.week is null
    const periods = { week: null, month: 1, lifetime: 1 };
    expect(await res.json()).toEqual({ ok: true, flagged: false, rank: { ...periods, usd: periods, output: periods, streak: periods } });
    const stored = await env.DB.prepare(`SELECT output_tokens, streak_days, active_days FROM users WHERE id = ?1`).bind(OCTOCAT.id).first<any>();
    expect(stored).toEqual({ output_tokens: 0, streak_days: 0, active_days: 0 });
    const weekly = await env.DB.prepare(`SELECT COUNT(*) AS n FROM weekly WHERE user_id = ?1`).bind(OCTOCAT.id).first<{ n: number }>();
    expect(weekly?.n).toBe(0);

    const user = await env.DB.prepare(`SELECT * FROM users WHERE id = ?1`).bind(OCTOCAT.id).first<any>();
    expect(user.lifetime_usd).toBeCloseTo(3100.25);
    expect(user.lifetime_tokens).toBe(120_000_000);
    expect(user.lifetime_calls).toBe(5000);
    expect(user.top_provider).toBe("claude");
    expect(user.flagged).toBe(0);
    expect(user.last_report_at).toBeTruthy();

    const monthly = await env.DB.prepare(`SELECT * FROM monthly WHERE user_id = ?1`).bind(OCTOCAT.id).all<any>();
    expect(monthly.results).toHaveLength(1);
    expect(monthly.results[0]).toMatchObject({ month: MONTH, usd: 620.5, tokens: 20_000_000, calls: 900, top_provider: "claude" });

    const reports = await env.DB.prepare(`SELECT * FROM reports WHERE user_id = ?1`).bind(OCTOCAT.id).all<any>();
    expect(reports.results).toHaveLength(1);
    expect(reports.results[0]).toMatchObject({ month: MONTH, month_usd: 620.5, lifetime_usd: 3100.25, flagged: 0 });
  });

  it("week slice: upserts the weekly row and returns rank.week", async () => {
    const token = await signIn(OCTOCAT);
    const weekBody = { week: WEEK, weekUSD: 200.25, weekTokens: 5_000_000, weekCalls: 120 };
    const res = await postReport(token, reportBody(weekBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, flagged: false, rank: { week: 1, month: 1, lifetime: 1 } });

    const rows = await env.DB.prepare(`SELECT * FROM weekly WHERE user_id = ?1`).bind(OCTOCAT.id).all<any>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ week: WEEK, usd: 200.25, tokens: 5_000_000, calls: 120, top_provider: "claude" });

    // upsert: a later report for the same week replaces the row
    await backdateLastReport(OCTOCAT.id, 11 * 60_000);
    expect((await postReport(token, reportBody({ ...weekBody, weekUSD: 260, weekCalls: 150 }))).status).toBe(200);
    const again = await env.DB.prepare(`SELECT usd, calls FROM weekly WHERE user_id = ?1`).bind(OCTOCAT.id).all<any>();
    expect(again.results).toEqual([{ usd: 260, calls: 150 }]);

    // rank.week counts only visible users with a higher weekly spend
    const tHubot = await signIn(HUBOT);
    const hubot = await postReport(tHubot, reportBody({ ...weekBody, weekUSD: 300 }));
    expect(((await hubot.json()) as any).rank).toMatchObject({ week: 1, month: 1, lifetime: 1 });
    await backdateLastReport(OCTOCAT.id, 11 * 60_000);
    const octo = await postReport(token, reportBody({ ...weekBody, weekUSD: 260, monthUSD: 700 }));
    expect(((await octo.json()) as any).rank).toMatchObject({ week: 2, month: 1, lifetime: 1, usd: { week: 2, month: 1, lifetime: 1 } });
  });

  it("week slice validation: 400 when partial, stale or malformed; 422 when weekUSD exceeds lifetimeUSD", async () => {
    const token = await signIn(OCTOCAT);
    const partial = await postReport(token, reportBody({ week: WEEK, weekUSD: 1 }));
    expect(partial.status).toBe(400);
    expect(((await partial.json()) as any).message).toMatch(/week/);
    expect((await postReport(token, reportBody({ week: "2000-W01", weekUSD: 1, weekTokens: 1, weekCalls: 1 }))).status).toBe(400);
    expect((await postReport(token, reportBody({ week: "2026-36", weekUSD: 1, weekTokens: 1, weekCalls: 1 }))).status).toBe(400);

    // week may exceed the month (calendar week straddling a month boundary) ...
    const straddle = await postReport(token, reportBody({ monthUSD: 50, week: WEEK, weekUSD: 400, weekTokens: 1, weekCalls: 1 }));
    expect(straddle.status).toBe(200);
    // ... but never lifetime
    await backdateLastReport(OCTOCAT.id, 11 * 60_000);
    const tooMuch = await postReport(token, reportBody({ week: WEEK, weekUSD: 4000, weekTokens: 1, weekCalls: 1 }));
    expect(tooMuch.status).toBe(422);
    expect(await tooMuch.json()).toMatchObject({ error: "implausible" });
    const tooManyTokens = await postReport(token, reportBody({ week: WEEK, weekUSD: 1, weekTokens: 200_000_000, weekCalls: 1 }));
    expect(tooManyTokens.status).toBe(422);
  });

  it("400 invalid_field with a clear message for bad input", async () => {
    const token = await signIn(OCTOCAT);
    const res = await postReport(token, reportBody({ monthUSD: -5 }));
    expect(res.status).toBe(400);
    const data: any = await res.json();
    expect(data).toMatchObject({ error: "invalid_field" });
    expect(data.message).toContain("monthUSD");

    const badMonth = await postReport(token, reportBody({ month: "2020-01" }));
    expect(badMonth.status).toBe(400);

    const notJson = await postReport(token, "{{{");
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ error: "invalid_json" });

    const big = await postReport(token, reportBody({ pad: "x".repeat(17_000) }));
    expect(big.status).toBe(413);
  });

  it("422 implausible: monthUSD > lifetimeUSD (+1%), monthTokens > lifetimeTokens", async () => {
    const token = await signIn(OCTOCAT);
    const r1 = await postReport(token, reportBody({ monthUSD: 4000, lifetimeUSD: 3100 }));
    expect(r1.status).toBe(422);
    expect(await r1.json()).toMatchObject({ error: "implausible" });
    const r2 = await postReport(token, reportBody({ monthTokens: 200_000_000, lifetimeTokens: 120_000_000 }));
    expect(r2.status).toBe(422);
    // a rejected report must not count as accepted (no rate-limit, no rows)
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM reports`).first<{ n: number }>();
    expect(rows?.n).toBe(0);
    const ok = await postReport(token, reportBody());
    expect(ok.status).toBe(200);
  });

  it("422 implausible when lifetimeUSD drops more than 10% below the previous value", async () => {
    const token = await signIn(OCTOCAT);
    expect((await postReport(token, reportBody({ lifetimeUSD: 3100.25 }))).status).toBe(200);
    await backdateLastReport(OCTOCAT.id, 11 * 60_000);
    const drop = await postReport(token, reportBody({ lifetimeUSD: 2700, monthUSD: 100 }));
    expect(drop.status).toBe(422);
    expect(await drop.json()).toMatchObject({ error: "implausible" });
    // within tolerance (repricing) is fine
    const ok = await postReport(token, reportBody({ lifetimeUSD: 2800, monthUSD: 100 }));
    expect(ok.status).toBe(200);
  });

  it("rate limit: one accepted report per 10 minutes → 429 with retryAfterSeconds", async () => {
    const token = await signIn(OCTOCAT);
    expect((await postReport(token, reportBody())).status).toBe(200);
    const second = await postReport(token, reportBody({ lifetimeUSD: 3101 }));
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toMatch(/^\d+$/);
    const data: any = await second.json();
    expect(data.error).toBe("rate_limited");
    expect(data.retryAfterSeconds).toBeGreaterThan(590);
    expect(data.retryAfterSeconds).toBeLessThanOrEqual(600);

    await backdateLastReport(OCTOCAT.id, 9 * 60_000);
    const third = await postReport(token, reportBody({ lifetimeUSD: 3101 }));
    expect(third.status).toBe(429);
    expect(((await third.json()) as any).retryAfterSeconds).toBeLessThanOrEqual(60);

    await backdateLastReport(OCTOCAT.id, 10 * 60_000 + 1000);
    const fourth = await postReport(token, reportBody({ lifetimeUSD: 3101 }));
    expect(fourth.status).toBe(200);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM reports`).first<{ n: number }>();
    expect(n?.n).toBe(2);
  });

  it("growth cap flags the user (accepted, flagged: true, hidden from boards)", async () => {
    const token = await signIn(OCTOCAT);
    expect((await postReport(token, reportBody({ lifetimeUSD: 3100.25 }))).status).toBe(200);
    await backdateLastReport(OCTOCAT.id, 60 * 60_000); // 1h → cap 3500
    const res = await postReport(token, reportBody({ lifetimeUSD: 3100.25 + 3501, lifetimeTokens: 500_000_000 }));
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data).toMatchObject({ ok: true, flagged: true });
    expect(data.flagReasons[0]).toMatch(/growth_cap/);

    const user = await env.DB.prepare(`SELECT flagged FROM users WHERE id = ?1`).bind(OCTOCAT.id).first<{ flagged: number }>();
    expect(user?.flagged).toBe(1);
    const rep = await env.DB.prepare(`SELECT flagged FROM reports ORDER BY id DESC LIMIT 1`).first<{ flagged: number }>();
    expect(rep?.flagged).toBe(1);

    const board = await getBoard("?board=lifetime");
    expect(board.data.entries).toEqual([]);
    expect(board.data.totalUsers).toBe(0);
  });

  it("growth cap scales with the time since the previous report", async () => {
    const token = await signIn(OCTOCAT);
    expect((await postReport(token, reportBody({ lifetimeUSD: 1000, monthUSD: 100 }))).status).toBe(200);
    await backdateLastReport(OCTOCAT.id, 3 * 24 * 60 * 60_000); // 3 days → cap 9500
    const res = await postReport(token, reportBody({ lifetimeUSD: 1000 + 9400, monthUSD: 100, lifetimeTokens: 900_000_000 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, flagged: false });
  });

  it("cost-per-token sanity flags the user", async () => {
    const token = await signIn(OCTOCAT);
    // 3100 USD over 1M tokens = 3100 USD / 1M → > 300
    const res = await postReport(token, reportBody({ lifetimeTokens: 1_000_000, monthTokens: 500_000 }));
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.flagged).toBe(true);
    expect(data.flagReasons[0]).toMatch(/cost_per_token/);
    const board = await getBoard("?board=month");
    expect(board.data.entries).toEqual([]);
  });

  it("flagged is sticky: later clean reports stay hidden, and 'me' reports flagged: true", async () => {
    const token = await signIn(OCTOCAT);
    expect((await postReport(token, reportBody({ lifetimeTokens: 1_000_000, monthTokens: 500_000 }))).status).toBe(200);
    await backdateLastReport(OCTOCAT.id, 11 * 60_000);
    const clean = await postReport(token, reportBody());
    expect(clean.status).toBe(200);
    expect(await clean.json()).toMatchObject({ ok: true, flagged: true });

    const board = await getBoard("?board=month", token);
    expect(board.data.entries).toEqual([]);
    expect(board.data.me).toMatchObject({ rank: 1, usd: 620.5, tokens: 20_000_000, calls: 900, flagged: true });
  });

  it("upserts the monthly row and keeps at most 500 report rows per user", async () => {
    const token = await signIn(OCTOCAT);
    expect((await postReport(token, reportBody({ monthUSD: 100 }))).status).toBe(200);
    await backdateLastReport(OCTOCAT.id, 11 * 60_000);
    expect((await postReport(token, reportBody({ monthUSD: 150, lifetimeUSD: 3150 }))).status).toBe(200);
    const monthly = await env.DB.prepare(`SELECT usd FROM monthly WHERE user_id = ?1`).bind(OCTOCAT.id).all<{ usd: number }>();
    expect(monthly.results).toEqual([{ usd: 150 }]);

    // pre-fill 600 audit rows, then one more report must trim to 500 (newest kept)
    const stmts = [];
    for (let i = 0; i < 600; i++) {
      stmts.push(
        env.DB.prepare(`INSERT INTO reports (user_id, received_at, month, month_usd, lifetime_usd, flagged) VALUES (?1, ?2, ?3, ?4, ?5, 0)`)
          .bind(OCTOCAT.id, new Date(Date.now() - (600 - i) * 1000).toISOString(), MONTH, i, 3150),
      );
    }
    await env.DB.batch(stmts);
    await backdateLastReport(OCTOCAT.id, 11 * 60_000);
    expect((await postReport(token, reportBody({ monthUSD: 160, lifetimeUSD: 3160 }))).status).toBe(200);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM reports WHERE user_id = ?1`).bind(OCTOCAT.id).first<{ n: number }>();
    expect(n?.n).toBe(500);
    const newest = await env.DB.prepare(`SELECT month_usd FROM reports WHERE user_id = ?1 ORDER BY id DESC LIMIT 1`).bind(OCTOCAT.id).first<{ month_usd: number }>();
    expect(newest?.month_usd).toBe(160);
  });
});

describe("GET /v1/leaderboard", () => {
  it("orders by USD, excludes flagged / opted-out users, returns me only with auth", async () => {
    const tOcto = await signIn(OCTOCAT);
    const tHubot = await signIn(HUBOT);
    const tMona = await signIn(MONA);
    expect((await postReport(tOcto, reportBody({ monthUSD: 620.5, lifetimeUSD: 3100.25 }))).status).toBe(200);
    expect((await postReport(tHubot, reportBody({ monthUSD: 900, lifetimeUSD: 1000 }))).status).toBe(200);
    // mona: flagged by cost-per-token
    expect((await postReport(tMona, reportBody({ monthUSD: 5000, lifetimeUSD: 9000, lifetimeTokens: 1_000_000, monthTokens: 1 }))).status).toBe(200);

    const anon = await getBoard("?board=month&limit=10&metric=usd");
    expect(anon.status).toBe(200);
    expect(anon.data.board).toBe("month");
    expect(anon.data.month).toBe(MONTH);
    expect(anon.data.totalUsers).toBe(2);
    expect(anon.data.me).toBeNull();
    expect(anon.data.entries.map((e: any) => [e.rank, e.login, e.usd])).toEqual([
      [1, "hubot", 900],
      [2, "octocat", 620.5],
    ]);
    expect(anon.data.entries[0]).toEqual({
      rank: 1,
      login: "hubot",
      avatarUrl: HUBOT.avatar_url,
      usd: 900,
      tokens: 20_000_000,
      outputTokens: 0,
      streakDays: 0,
      calls: 900,
      topProvider: "claude",
      value: 900,
    });
    expect(typeof anon.data.updatedAt).toBe("string");

    const mine = await getBoard("?board=month&metric=usd", tOcto);
    expect(mine.data.me).toEqual({ rank: 2, usd: 620.5, tokens: 20_000_000, outputTokens: 0, streakDays: 0, calls: 900, value: 620.5, flagged: false });

    const life = await getBoard("?board=lifetime&metric=usd", tHubot);
    expect(life.data.entries.map((e: any) => [e.rank, e.login, e.usd])).toEqual([
      [1, "octocat", 3100.25],
      [2, "hubot", 1000],
    ]);
    expect(life.data.me).toEqual({ rank: 2, usd: 1000, tokens: 120_000_000, outputTokens: 0, streakDays: 0, calls: 5000, value: 1000, flagged: false });

    // opt-out hides too
    await env.DB.prepare(`UPDATE users SET opt_out = 1 WHERE id = ?1`).bind(HUBOT.id).run();
    const afterOptOut = await getBoard("?board=month");
    expect(afterOptOut.data.entries.map((e: any) => e.login)).toEqual(["octocat"]);
    expect(afterOptOut.data.totalUsers).toBe(1);
  });

  it("board=week orders by weekly spend, names the week (no month), reports me, hides flagged/opt-out", async () => {
    const tOcto = await signIn(OCTOCAT);
    const tHubot = await signIn(HUBOT);
    const tMona = await signIn(MONA);
    const week = (usd: number, tokens = 5_000_000, calls = 120) => ({ week: WEEK, weekUSD: usd, weekTokens: tokens, weekCalls: calls });
    await postReport(tOcto, reportBody(week(150)));
    await postReport(tHubot, reportBody({ monthUSD: 900, lifetimeUSD: 1000, lifetimeTokens: 120_000_000, ...week(400, 8_000_000, 300) }));
    // mona reports no week at all: she is on the month board but not the week board
    await postReport(tMona, reportBody({ monthUSD: 5000, lifetimeUSD: 9000, lifetimeTokens: 300_000_000 }));

    const anon = await getBoard("?board=week&metric=usd");
    expect(anon.status).toBe(200);
    expect(anon.data.board).toBe("week");
    expect(anon.data.metric).toBe("usd");
    expect(anon.data.week).toBe(WEEK);
    expect(anon.data).not.toHaveProperty("month");
    expect(anon.data.totalUsers).toBe(2);
    expect(anon.data.me).toBeNull();
    expect(anon.data.entries.map((e: any) => [e.rank, e.login, e.usd])).toEqual([
      [1, "hubot", 400],
      [2, "octocat", 150],
    ]);
    expect(anon.data.entries[0]).toEqual({
      rank: 1,
      login: "hubot",
      avatarUrl: HUBOT.avatar_url,
      usd: 400,
      tokens: 8_000_000,
      outputTokens: 0,
      streakDays: 0,
      calls: 300,
      topProvider: "claude",
      value: 400,
    });

    const mine = await getBoard("?board=week&metric=usd", tOcto);
    expect(mine.data.me).toEqual({ rank: 2, usd: 150, tokens: 5_000_000, outputTokens: 0, streakDays: 0, calls: 120, value: 150, flagged: false });
    const monaWeek = await getBoard("?board=week", tMona);
    expect(monaWeek.data.me).toBeNull();
    const monaMonth = await getBoard("?board=month", tMona);
    expect(monaMonth.data.me?.rank).toBe(1);

    // explicit week selection and validation
    const other = await getBoard(`?board=week&week=2000-W01`);
    expect(other.data.week).toBe("2000-W01");
    expect(other.data.entries).toEqual([]);
    expect(other.data.totalUsers).toBe(0);
    expect((await getBoard("?board=week&week=2026-36")).status).toBe(400);
    expect((await getBoard("?board=week&week=2026-W54")).status).toBe(400);
    expect((await getBoard("?board=week&limit=1")).data.entries.map((e: any) => e.login)).toEqual(["hubot"]);

    // the month board is unaffected by the week slice
    const month = await getBoard("?board=month");
    expect(month.data.entries.map((e: any) => e.login)).toEqual(["mona", "hubot", "octocat"]);
    expect(month.data).not.toHaveProperty("week");

    // opt-out and flagged users vanish from the week board too
    await env.DB.prepare(`UPDATE users SET opt_out = 1 WHERE id = ?1`).bind(HUBOT.id).run();
    const afterOptOut = await getBoard("?board=week", tOcto);
    expect(afterOptOut.data.entries.map((e: any) => e.login)).toEqual(["octocat"]);
    expect(afterOptOut.data.totalUsers).toBe(1);
    expect(afterOptOut.data.me?.rank).toBe(1);
    await env.DB.prepare(`UPDATE users SET flagged = 1 WHERE id = ?1`).bind(OCTOCAT.id).run();
    const afterFlag = await getBoard("?board=week");
    expect(afterFlag.data.entries).toEqual([]);
  });

  it("defaults, limits, month selection and validation", async () => {
    const t = await signIn(OCTOCAT);
    await postReport(t, reportBody());

    const def = await getBoard("");
    expect(def.data.board).toBe("month");
    expect(def.data.month).toBe(MONTH);
    expect(def.data.metric).toBe("output");
    expect((await getBoard("?metric=spend")).status).toBe(400);
    expect((await getBoard("?metric=streak")).data.metric).toBe("streak");

    const other = await getBoard("?board=month&month=2000-01");
    expect(other.data.entries).toEqual([]);
    expect(other.data.totalUsers).toBe(0);

    const meOther = await getBoard("?board=month&month=2000-01", t);
    expect(meOther.data.me).toBeNull();

    expect((await getBoard("?board=weekly")).status).toBe(400);
    expect((await getBoard("?board=week")).status).toBe(200);
    expect((await getBoard("?limit=0")).status).toBe(400);
    expect((await getBoard("?limit=101")).status).toBe(400);
    expect((await getBoard("?limit=abc")).status).toBe(400);
    expect((await getBoard("?month=2026-9")).status).toBe(400);
    expect((await getBoard("?limit=1")).data.entries).toHaveLength(1);
  });

  it("limit caps entries but totalUsers still counts everyone visible", async () => {
    const t1 = await signIn(OCTOCAT);
    const t2 = await signIn(HUBOT);
    await postReport(t1, reportBody({ monthUSD: 10, lifetimeUSD: 100 }));
    await postReport(t2, reportBody({ monthUSD: 20, lifetimeUSD: 200 }));
    const res = await getBoard("?board=lifetime&limit=1");
    expect(res.data.entries).toHaveLength(1);
    expect(res.data.entries[0].login).toBe("hubot");
    expect(res.data.totalUsers).toBe(2);
  });

  it("401 when an Authorization header is present but invalid", async () => {
    const res = await getBoard("?board=month", "f".repeat(64));
    expect(res.status).toBe(401);
    expect(res.data).toMatchObject({ error: "unauthorized" });
  });

  it("cache headers: public 60s anonymously, no-store with auth", async () => {
    const t = await signIn(OCTOCAT);
    const anon = await SELF.fetch(`${BASE}/v1/leaderboard`);
    expect(anon.headers.get("cache-control")).toBe("public, max-age=60");
    const auth = await SELF.fetch(`${BASE}/v1/leaderboard`, { headers: { Authorization: `Bearer ${t}` } });
    expect(auth.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("metrics", () => {
  const metrics = (over: Record<string, unknown>) => ({
    week: WEEK, weekUSD: 10, weekTokens: 1_000_000, weekCalls: 10, weekOutputTokens: 100_000,
    monthOutputTokens: 2_000_000, lifetimeOutputTokens: 30_000_000, streakDays: 3, activeDays: 40,
    ...over,
  });

  it("stores output tokens per period and streak / active days per user; ranks per metric", async () => {
    const t = await signIn(OCTOCAT);
    const res = await postReport(t, reportBody(metrics({})));
    expect(res.status).toBe(200);
    const data: any = await res.json();
    const one = { week: 1, month: 1, lifetime: 1 };
    expect(data.rank).toEqual({ ...one, usd: one, output: one, streak: one });

    const user = await env.DB.prepare(`SELECT output_tokens, streak_days, active_days FROM users WHERE id = ?1`).bind(OCTOCAT.id).first<any>();
    expect(user).toEqual({ output_tokens: 30_000_000, streak_days: 3, active_days: 40 });
    const month = await env.DB.prepare(`SELECT output_tokens FROM monthly WHERE user_id = ?1`).bind(OCTOCAT.id).first<any>();
    expect(month.output_tokens).toBe(2_000_000);
    const week = await env.DB.prepare(`SELECT output_tokens FROM weekly WHERE user_id = ?1`).bind(OCTOCAT.id).first<any>();
    expect(week.output_tokens).toBe(100_000);
  });

  it("422 when output tokens exceed total tokens; streak growth beyond elapsed days flags", async () => {
    const t = await signIn(OCTOCAT);
    expect((await postReport(t, reportBody(metrics({ monthOutputTokens: 20_000_001 })))).status).toBe(422);
    expect((await postReport(t, reportBody(metrics({ weekOutputTokens: 1_000_001 })))).status).toBe(422);
    expect((await postReport(t, reportBody(metrics({ streakDays: 50, activeDays: 40 })))).status).toBe(400);
    expect((await postReport(t, reportBody(metrics({})))).status).toBe(200);
    await backdateLastReport(OCTOCAT.id, 2 * 3_600_000); // 2h → +1 day allowed
    const jump = await postReport(t, reportBody(metrics({ streakDays: 5, activeDays: 42 })));
    expect(jump.status).toBe(200);
    const data: any = await jump.json();
    expect(data.flagged).toBe(true);
    expect(data.flagReasons.join(" ")).toMatch(/streak_growth/);
  });

  it("board ordering per metric with value echo; streak is the same scalar on every board, tie-broken by output", async () => {
    const tOcto = await signIn(OCTOCAT);
    const tHubot = await signIn(HUBOT);
    const tMona = await signIn(MONA);
    // octocat: most spend, least output, streak 3
    await postReport(tOcto, reportBody(metrics({ monthUSD: 900, lifetimeUSD: 3000, monthOutputTokens: 1_000_000, lifetimeOutputTokens: 5_000_000, streakDays: 3, activeDays: 40 })));
    // hubot: mid spend, most output, streak 7
    await postReport(tHubot, reportBody(metrics({ monthUSD: 500, lifetimeUSD: 2000, monthOutputTokens: 9_000_000, lifetimeOutputTokens: 50_000_000, streakDays: 7, activeDays: 70 })));
    // mona: least spend, mid output, streak 7 (ties hubot → hubot first on output)
    await postReport(tMona, reportBody(metrics({ monthUSD: 100, lifetimeUSD: 1000, monthOutputTokens: 4_000_000, lifetimeOutputTokens: 20_000_000, streakDays: 7, activeDays: 30 })));

    const byDefault = await getBoard("?board=month");
    expect(byDefault.data.metric).toBe("output");
    expect(byDefault.data.entries.map((e: any) => [e.login, e.value])).toEqual([
      ["hubot", 9_000_000],
      ["mona", 4_000_000],
      ["octocat", 1_000_000],
    ]);
    expect(byDefault.data.entries[0]).toMatchObject({ usd: 500, outputTokens: 9_000_000, streakDays: 7, calls: 900, tokens: 20_000_000 });

    const usd = await getBoard("?board=month&metric=usd");
    expect(usd.data.entries.map((e: any) => [e.login, e.value])).toEqual([["octocat", 900], ["hubot", 500], ["mona", 100]]);

    const streak = await getBoard("?board=month&metric=streak", tOcto);
    expect(streak.data.entries.map((e: any) => [e.rank, e.login, e.value])).toEqual([[1, "hubot", 7], [2, "mona", 7], [3, "octocat", 3]]);
    expect(streak.data.me).toMatchObject({ rank: 3, value: 3, streakDays: 3, outputTokens: 1_000_000, usd: 900 });

    const lifeOutput = await getBoard("?board=lifetime", tMona);
    expect(lifeOutput.data.entries.map((e: any) => [e.login, e.value])).toEqual([["hubot", 50_000_000], ["mona", 20_000_000], ["octocat", 5_000_000]]);
    expect(lifeOutput.data.me).toMatchObject({ rank: 2, value: 20_000_000, streakDays: 7 });
    const lifeStreak = await getBoard("?board=lifetime&metric=streak", tMona);
    expect(lifeStreak.data.entries.map((e: any) => e.login)).toEqual(["hubot", "mona", "octocat"]);
    // ties never push the rank down
    expect(lifeStreak.data.me?.rank).toBe(1);

    // week board: hubot and mona tie on streak, week output AND week usd → lowest user id first (mona = 1)
    const weekStreak = await getBoard("?board=week&metric=streak");
    expect(weekStreak.data.entries.map((e: any) => [e.login, e.value, e.outputTokens])).toEqual([
      ["mona", 7, 100_000],
      ["hubot", 7, 100_000],
      ["octocat", 3, 100_000],
    ]);

    // per-metric ranks in the report response for the last reporter (mona)
    await backdateLastReport(MONA.id, 11 * 60_000);
    const again: any = await (await postReport(tMona, reportBody(metrics({ monthUSD: 100, lifetimeUSD: 1000, monthOutputTokens: 4_000_000, lifetimeOutputTokens: 20_000_000, streakDays: 7, activeDays: 30 })))).json();
    // every week value is tied three ways, so each week rank is 1 (ties never push down)
    expect(again.rank).toEqual({
      week: 1, month: 3, lifetime: 3,
      usd: { week: 1, month: 3, lifetime: 3 },
      output: { week: 1, month: 2, lifetime: 2 },
      streak: { week: 1, month: 1, lifetime: 1 },
    });
  });
});

describe("DELETE /v1/me", () => {
  it("removes the user, all sessions, weekly and monthly rows and reports; token stops working", async () => {
    const t1 = await signIn(OCTOCAT);
    const t2 = await signIn(OCTOCAT);
    const tHubot = await signIn(HUBOT);
    const week = { week: WEEK, weekUSD: 1, weekTokens: 1, weekCalls: 1 };
    await postReport(t1, reportBody(week));
    await postReport(tHubot, reportBody({ monthUSD: 1, lifetimeUSD: 10, lifetimeTokens: 1_000_000, monthTokens: 1, ...week }));
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM weekly`).first<{ n: number }>())?.n).toBe(2);

    const res = await SELF.fetch(`${BASE}/v1/me`, { method: "DELETE", headers: { Authorization: `Bearer ${t1}` } });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");

    const count = async (sql: string) => (await env.DB.prepare(sql).bind(OCTOCAT.id).first<{ n: number }>())!.n;
    expect(await count(`SELECT COUNT(*) AS n FROM users WHERE id = ?1`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM monthly WHERE user_id = ?1`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM weekly WHERE user_id = ?1`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM reports WHERE user_id = ?1`)).toBe(0);

    // other users untouched
    const hubot = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE id = ?1`).bind(HUBOT.id).first<{ n: number }>();
    expect(hubot?.n).toBe(1);
    const hubotWeek = await env.DB.prepare(`SELECT COUNT(*) AS n FROM weekly WHERE user_id = ?1`).bind(HUBOT.id).first<{ n: number }>();
    expect(hubotWeek?.n).toBe(1);
    expect((await getBoard("?board=week")).data.entries.map((e: any) => e.login)).toEqual(["hubot"]);

    expect((await postReport(t1, reportBody())).status).toBe(401);
    expect((await postReport(t2, reportBody())).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/v1/me`, { method: "DELETE", headers: { Authorization: `Bearer ${t1}` } })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/v1/me`, { method: "DELETE" })).status).toBe(401);

    const board = await getBoard("?board=month");
    expect(board.data.entries.map((e: any) => e.login)).toEqual(["hubot"]);
  });
});
