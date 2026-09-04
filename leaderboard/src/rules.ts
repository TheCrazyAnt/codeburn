// Pure, side-effect-free validation and anti-cheat rules for POST /v1/report.
// Kept separate from the Worker so they can be unit-tested without D1.
// Every rule mirrors API.md ("Server rules") exactly.

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** ISO 8601 week key, YYYY-Www (W01..W53). */
export const WEEK_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
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
/** streakDays upper bound (~10 years). */
export const MAX_STREAK_DAYS = 3660;

/** What a board ranks by. Stable API identifiers. */
export const METRICS = ["usd", "output", "streak"] as const;
export type Metric = (typeof METRICS)[number];
export const DEFAULT_METRIC: Metric = "output";

export function isMetric(v: string): v is Metric {
  return (METRICS as readonly string[]).includes(v);
}

export interface ProviderSplit {
  id: string;
  monthUSD: number;
  lifetimeUSD: number;
}

/**
 * Optional calendar-week slice: the client's local Monday 00:00 → now, keyed
 * as an ISO week. A calendar week can straddle two months, so weekUSD is NOT
 * bounded by monthUSD — only by lifetimeUSD.
 */
export interface WeekSlice {
  week: string;
  weekUSD: number;
  weekTokens: number;
  weekCalls: number;
  /** Model output tokens in the week; null when the client did not send it. */
  weekOutputTokens: number | null;
}

export interface ReportInput {
  month: string;
  monthUSD: number;
  monthTokens: number;
  monthCalls: number;
  lifetimeUSD: number;
  lifetimeTokens: number;
  lifetimeCalls: number;
  /** null when the client sent no week fields (older clients). */
  week: WeekSlice | null;
  /** Model output tokens per period; null when not sent (older clients). */
  monthOutputTokens: number | null;
  lifetimeOutputTokens: number | null;
  /** Consecutive active days up to today (or yesterday); null when not sent. */
  streakDays: number | null;
  /** Distinct active days ever; null when not sent. */
  activeDays: number | null;
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

const DAY_MS = 86_400_000;

/** ISO 8601 week ("YYYY-Www") of a timestamp in UTC. Weeks start Monday; week 1 holds January 4. */
export function utcIsoWeek(ms: number): string {
  const d = new Date(ms);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
  // The ISO year/week of a date are those of the Thursday in its week.
  const thursday = day + (3 - dow) * DAY_MS;
  const isoYear = new Date(thursday).getUTCFullYear();
  const jan4 = Date.UTC(isoYear, 0, 4);
  const jan4dow = (new Date(jan4).getUTCDay() + 6) % 7;
  const week1Thursday = jan4 + (3 - jan4dow) * DAY_MS;
  const week = 1 + Math.round((thursday - week1Thursday) / (7 * DAY_MS));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * Weeks a client may report for: the current UTC ISO week and its neighbours
 * (the client uses *local* time, which can sit on the other side of a Monday).
 */
export function allowedWeeks(nowMs: number): Set<string> {
  return new Set([utcIsoWeek(nowMs - 7 * DAY_MS), utcIsoWeek(nowMs), utcIsoWeek(nowMs + 7 * DAY_MS)]);
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

  // Week slice: all four fields present, or all absent (undefined/null).
  const weekFields = ["week", "weekUSD", "weekTokens", "weekCalls"] as const;
  const weekPresent = weekFields.filter((f) => body[f] !== undefined && body[f] !== null);
  let week: WeekSlice | null = null;
  if (weekPresent.length > 0) {
    if (weekPresent.length !== weekFields.length) {
      return { ok: false, message: "week, weekUSD, weekTokens and weekCalls must be sent together (or all omitted)" };
    }
    const weekKey = body.week;
    if (typeof weekKey !== "string" || !WEEK_RE.test(weekKey)) {
      return { ok: false, message: "week must be a string formatted YYYY-Www (ISO week)" };
    }
    if (!allowedWeeks(nowMs).has(weekKey)) {
      return { ok: false, message: `week ${weekKey} is not the current week (±1 week tolerance)` };
    }
    for (const f of ["weekUSD", "weekTokens", "weekCalls"] as const) {
      if (!nonNegativeFinite(body[f])) {
        return { ok: false, message: `${f} must be a finite number >= 0` };
      }
    }
    week = {
      week: weekKey,
      weekUSD: body.weekUSD as number,
      weekTokens: Math.round(body.weekTokens as number),
      weekCalls: Math.round(body.weekCalls as number),
      weekOutputTokens: null,
    };
  }

  // Metric fields: optional, but each must be a finite non-negative number when present.
  const optionalCount = (f: string): { ok: true; value: number | null } | { ok: false; message: string } => {
    const v = body[f];
    if (v === undefined || v === null) return { ok: true, value: null };
    if (!nonNegativeFinite(v)) return { ok: false, message: `${f} must be a finite number >= 0` };
    return { ok: true, value: Math.round(v) };
  };
  const optional: Record<"weekOutputTokens" | "monthOutputTokens" | "lifetimeOutputTokens" | "streakDays" | "activeDays", number | null> = {
    weekOutputTokens: null,
    monthOutputTokens: null,
    lifetimeOutputTokens: null,
    streakDays: null,
    activeDays: null,
  };
  for (const f of Object.keys(optional) as (keyof typeof optional)[]) {
    const r = optionalCount(f);
    if (!r.ok) return r;
    optional[f] = r.value;
  }
  if (optional.weekOutputTokens !== null) {
    if (week === null) return { ok: false, message: "weekOutputTokens requires the week fields" };
    week.weekOutputTokens = optional.weekOutputTokens;
  }
  if (optional.streakDays !== null && optional.streakDays > MAX_STREAK_DAYS) {
    return { ok: false, message: `streakDays must be at most ${MAX_STREAK_DAYS}` };
  }
  if (optional.activeDays !== null && optional.streakDays !== null && optional.activeDays < optional.streakDays) {
    return { ok: false, message: "activeDays must be at least streakDays" };
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
      week,
      monthOutputTokens: optional.monthOutputTokens,
      lifetimeOutputTokens: optional.lifetimeOutputTokens,
      streakDays: optional.streakDays,
      activeDays: optional.activeDays,
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
  /** Stored streak / active days (0 when never reported). */
  streakDays?: number;
  activeDays?: number;
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
  // A calendar week may straddle two months, so the week is bounded by
  // lifetime only (same 1% tolerance), never by the month.
  if (report.week && report.week.weekUSD > report.lifetimeUSD * MONTH_VS_LIFETIME_TOLERANCE) {
    return {
      verdict: "reject",
      message: `weekUSD (${report.week.weekUSD}) exceeds lifetimeUSD (${report.lifetimeUSD}) by more than 1%`,
    };
  }
  if (report.week && report.week.weekTokens > report.lifetimeTokens) {
    return {
      verdict: "reject",
      message: `weekTokens (${report.week.weekTokens}) exceeds lifetimeTokens (${report.lifetimeTokens})`,
    };
  }
  // Output tokens are a subset of the period's total tokens.
  const outputChecks: Array<[string, number | null, string, number]> = [
    ["monthOutputTokens", report.monthOutputTokens, "monthTokens", report.monthTokens],
    ["lifetimeOutputTokens", report.lifetimeOutputTokens, "lifetimeTokens", report.lifetimeTokens],
    ["weekOutputTokens", report.week?.weekOutputTokens ?? null, "weekTokens", report.week?.weekTokens ?? 0],
  ];
  for (const [name, output, totalName, total] of outputChecks) {
    if (output !== null && output > total) {
      return { verdict: "reject", message: `${name} (${output}) exceeds ${totalName} (${total})` };
    }
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
    // No growth check on streakDays / activeDays. They are recounted from the
    // client's daily history on every report, not incremented, so a longer
    // history window legitimately reveals more active days in one step. The
    // absolute bound in validateReport is what keeps them sane.
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
