// Pure, side-effect-free validation and anti-cheat rules for POST /v1/report.
// Kept separate from the Worker so they can be unit-tested without D1.
// Every rule mirrors API.md ("Server rules") exactly.

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const PROVIDER_ID_RE = /^[A-Za-z0-9_.-]{1,32}$/;
export const MAX_PROVIDERS = 32;
export const MAX_APP_VERSION_LEN = 64;

/** One accepted report per user per 10 minutes. */
export const RATE_LIMIT_MS = 10 * 60 * 1000;
/** monthUSD may exceed lifetimeUSD by at most 1 % (rounding / repricing). */
export const MONTH_VS_LIFETIME_TOLERANCE = 1.01;
/** lifetimeUSD may not drop more than 10 % below the previous value. */
export const LIFETIME_DROP_TOLERANCE = 0.9;
/** growth cap: (Δ lifetimeUSD) ≤ 3000 × max(1, hours/24) + 500. */
export const GROWTH_USD_PER_DAY = 3000;
export const GROWTH_SLACK_USD = 500;
/** cost-per-token sanity window, USD per 1M tokens. */
export const MIN_USD_PER_MTOK = 0.02;
export const MAX_USD_PER_MTOK = 300;

export interface ProviderSplit {
  id: string;
  monthUSD: number;
  lifetimeUSD: number;
}

export interface ReportInput {
  month: string;
  monthUSD: number;
  monthTokens: number;
  monthCalls: number;
  lifetimeUSD: number;
  lifetimeTokens: number;
  lifetimeCalls: number;
  byProvider: ProviderSplit[];
  appVersion: string;
  reportedAt: string;
}

export type ValidationResult =
  | { ok: true; report: ReportInput }
  | { ok: false; message: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonNegativeFinite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** YYYY-MM of a timestamp in UTC. */
export function utcMonth(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Months a client may report for: the current UTC month and its neighbours
 * (the client uses *local* time, which can be ±1 day around a UTC month boundary).
 */
export function allowedMonths(nowMs: number): Set<string> {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const fmt = (yy: number, mm: number) => {
    const dd = new Date(Date.UTC(yy, mm, 1));
    return `${dd.getUTCFullYear()}-${String(dd.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  return new Set([fmt(y, m - 1), fmt(y, m), fmt(y, m + 1)]);
}

/** Structural validation → 400-class problems. Does not apply plausibility rules. */
export function validateReport(body: unknown, nowMs: number): ValidationResult {
  if (!isRecord(body)) return { ok: false, message: "body must be a JSON object" };

  const month = body.month;
  if (typeof month !== "string" || !MONTH_RE.test(month)) {
    return { ok: false, message: "month must be a string formatted YYYY-MM" };
  }
  if (!allowedMonths(nowMs).has(month)) {
    return { ok: false, message: `month ${month} is not the current month (±1 month tolerance)` };
  }

  const numericFields = [
    "monthUSD",
    "monthTokens",
    "monthCalls",
    "lifetimeUSD",
    "lifetimeTokens",
    "lifetimeCalls",
  ] as const;
  const nums: Record<(typeof numericFields)[number], number> = {
    monthUSD: 0,
    monthTokens: 0,
    monthCalls: 0,
    lifetimeUSD: 0,
    lifetimeTokens: 0,
    lifetimeCalls: 0,
  };
  for (const f of numericFields) {
    const v = body[f];
    if (!nonNegativeFinite(v)) {
      return { ok: false, message: `${f} must be a finite number >= 0` };
    }
    nums[f] = v;
  }

  const byProvider: ProviderSplit[] = [];
  if (body.byProvider !== undefined && body.byProvider !== null) {
    if (!Array.isArray(body.byProvider)) {
      return { ok: false, message: "byProvider must be an array" };
    }
    if (body.byProvider.length > MAX_PROVIDERS) {
      return { ok: false, message: `byProvider may contain at most ${MAX_PROVIDERS} entries` };
    }
    const seen = new Set<string>();
    for (const [i, raw] of body.byProvider.entries()) {
      if (!isRecord(raw)) return { ok: false, message: `byProvider[${i}] must be an object` };
      const id = raw.id;
      if (typeof id !== "string" || !PROVIDER_ID_RE.test(id)) {
        return { ok: false, message: `byProvider[${i}].id must match ${PROVIDER_ID_RE}` };
      }
      if (seen.has(id)) return { ok: false, message: `byProvider contains duplicate id "${id}"` };
      seen.add(id);
      if (!nonNegativeFinite(raw.monthUSD)) {
        return { ok: false, message: `byProvider[${i}].monthUSD must be a finite number >= 0` };
      }
      if (!nonNegativeFinite(raw.lifetimeUSD)) {
        return { ok: false, message: `byProvider[${i}].lifetimeUSD must be a finite number >= 0` };
      }
      byProvider.push({ id, monthUSD: raw.monthUSD, lifetimeUSD: raw.lifetimeUSD });
    }
  }

  const appVersion = body.appVersion;
  if (typeof appVersion !== "string" || appVersion.length === 0 || appVersion.length > MAX_APP_VERSION_LEN) {
    return { ok: false, message: `appVersion must be a non-empty string (max ${MAX_APP_VERSION_LEN} chars)` };
  }

  const reportedAt = body.reportedAt;
  if (typeof reportedAt !== "string" || Number.isNaN(Date.parse(reportedAt))) {
    return { ok: false, message: "reportedAt must be an ISO-8601 timestamp string" };
  }

  return {
    ok: true,
    report: {
      month,
      monthUSD: nums.monthUSD,
      monthTokens: Math.round(nums.monthTokens),
      monthCalls: Math.round(nums.monthCalls),
      lifetimeUSD: nums.lifetimeUSD,
      lifetimeTokens: Math.round(nums.lifetimeTokens),
      lifetimeCalls: Math.round(nums.lifetimeCalls),
      byProvider,
      appVersion,
      reportedAt,
    },
  };
}

/** What the server already knows about the user (null → first report ever). */
export interface PreviousState {
  lifetimeUsd: number;
  lastReportAtMs: number;
}

export type Evaluation =
  | { verdict: "reject"; message: string }
  | { verdict: "accept"; flagged: boolean; reasons: string[] };

/** Plausibility rules: 422 ("reject") vs accept-and-maybe-flag. */
export function evaluateReport(
  report: ReportInput,
  previous: PreviousState | null,
  nowMs: number,
): Evaluation {
  // --- hard rejections (422) -------------------------------------------------
  if (report.monthUSD > report.lifetimeUSD * MONTH_VS_LIFETIME_TOLERANCE) {
    return {
      verdict: "reject",
      message: `monthUSD (${report.monthUSD}) exceeds lifetimeUSD (${report.lifetimeUSD}) by more than 1%`,
    };
  }
  if (report.monthTokens > report.lifetimeTokens) {
    return {
      verdict: "reject",
      message: `monthTokens (${report.monthTokens}) exceeds lifetimeTokens (${report.lifetimeTokens})`,
    };
  }
  if (previous && report.lifetimeUSD < previous.lifetimeUsd * LIFETIME_DROP_TOLERANCE) {
    return {
      verdict: "reject",
      message: `lifetimeUSD (${report.lifetimeUSD}) dropped more than 10% below the previous value (${previous.lifetimeUsd})`,
    };
  }

  // --- soft rules (accept, flagged = 1) --------------------------------------
  const reasons: string[] = [];

  if (previous) {
    const hours = Math.max(0, nowMs - previous.lastReportAtMs) / 3_600_000;
    const cap = GROWTH_USD_PER_DAY * Math.max(1, hours / 24) + GROWTH_SLACK_USD;
    const delta = report.lifetimeUSD - previous.lifetimeUsd;
    if (delta > cap) {
      reasons.push(`growth_cap: +${delta.toFixed(2)} USD in ${hours.toFixed(1)}h exceeds ${cap.toFixed(2)} USD`);
    }
  }

  if (report.lifetimeTokens > 0) {
    const usdPerMTok = report.lifetimeUSD / (report.lifetimeTokens / 1e6);
    if (usdPerMTok < MIN_USD_PER_MTOK || usdPerMTok > MAX_USD_PER_MTOK) {
      reasons.push(
        `cost_per_token: ${usdPerMTok.toFixed(4)} USD/1M tokens outside [${MIN_USD_PER_MTOK}, ${MAX_USD_PER_MTOK}]`,
      );
    }
  }

  return { verdict: "accept", flagged: reasons.length > 0, reasons };
}

/** Seconds the caller must wait, or 0 when a report is allowed now. */
export function rateLimitRetryAfter(lastReportAtMs: number | null, nowMs: number): number {
  if (lastReportAtMs === null) return 0;
  const elapsed = nowMs - lastReportAtMs;
  if (elapsed >= RATE_LIMIT_MS) return 0;
  return Math.max(1, Math.ceil((RATE_LIMIT_MS - elapsed) / 1000));
}

/** Provider with the largest spend for the given key; null when no split was sent. */
export function topProvider(
  byProvider: ProviderSplit[],
  key: "monthUSD" | "lifetimeUSD",
): string | null {
  let best: ProviderSplit | null = null;
  for (const p of byProvider) {
    if (best === null || p[key] > best[key]) best = p;
  }
  return best ? best.id : null;
}
