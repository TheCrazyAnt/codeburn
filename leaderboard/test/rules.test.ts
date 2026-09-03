import { describe, expect, it } from "vitest";
import {
  allowedMonths,
  allowedWeeks,
  evaluateReport,
  rateLimitRetryAfter,
  topProvider,
  utcIsoWeek,
  utcMonth,
  validateReport,
  type ReportInput,
} from "../src/rules";

const NOW = Date.UTC(2026, 8, 3, 4, 0, 0); // 2026-09-03T04:00:00Z

function baseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    month: "2026-09",
    monthUSD: 5849.91,
    monthTokens: 166_300_000,
    monthCalls: 4173,
    lifetimeUSD: 31922.22,
    lifetimeTokens: 500_000_000,
    lifetimeCalls: 73150,
    byProvider: [
      { id: "claude", monthUSD: 5000, lifetimeUSD: 31330.98 },
      { id: "codex", monthUSD: 849.91, lifetimeUSD: 591.24 },
    ],
    appVersion: "0.9.23-zh4",
    reportedAt: "2026-09-03T04:00:00Z",
    ...overrides,
  };
}

function validReport(overrides: Partial<ReportInput> = {}): ReportInput {
  const r = validateReport(baseBody(), NOW);
  if (!r.ok) throw new Error(r.message);
  return { ...r.report, ...overrides };
}

describe("utcMonth / allowedMonths", () => {
  it("formats the UTC month", () => {
    expect(utcMonth(NOW)).toBe("2026-09");
    expect(utcMonth(Date.UTC(2026, 0, 1))).toBe("2026-01");
  });
  it("allows the current month and its neighbours, wrapping years", () => {
    expect([...allowedMonths(NOW)].sort()).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect([...allowedMonths(Date.UTC(2026, 11, 15))].sort()).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect([...allowedMonths(Date.UTC(2026, 0, 15))].sort()).toEqual(["2025-12", "2026-01", "2026-02"]);
  });
});

describe("utcIsoWeek / allowedWeeks", () => {
  it("formats the ISO week of a UTC timestamp", () => {
    expect(utcIsoWeek(NOW)).toBe("2026-W36"); // Thursday
    expect(utcIsoWeek(Date.UTC(2026, 7, 31))).toBe("2026-W36"); // Monday 00:00
    expect(utcIsoWeek(Date.UTC(2026, 7, 30, 23, 59, 59))).toBe("2026-W35"); // Sunday, one second earlier
    expect(utcIsoWeek(Date.UTC(2026, 8, 6, 23, 59, 59))).toBe("2026-W36"); // Sunday, end of the week
    expect(utcIsoWeek(Date.UTC(2026, 8, 7))).toBe("2026-W37");
  });
  it("assigns the year boundary to the ISO year of the week's Thursday", () => {
    expect(utcIsoWeek(Date.UTC(2027, 0, 1))).toBe("2026-W53"); // Friday; 2026 has 53 ISO weeks
    expect(utcIsoWeek(Date.UTC(2027, 0, 3))).toBe("2026-W53"); // Sunday
    expect(utcIsoWeek(Date.UTC(2027, 0, 4))).toBe("2027-W01"); // Monday
    expect(utcIsoWeek(Date.UTC(2024, 11, 30))).toBe("2025-W01"); // Monday before New Year
    expect(utcIsoWeek(Date.UTC(2021, 0, 3))).toBe("2020-W53");
    expect(utcIsoWeek(Date.UTC(2021, 0, 4))).toBe("2021-W01");
  });
  it("allows the current week and its neighbours, wrapping years", () => {
    expect([...allowedWeeks(NOW)].sort()).toEqual(["2026-W35", "2026-W36", "2026-W37"]);
    expect([...allowedWeeks(Date.UTC(2027, 0, 1))].sort()).toEqual(["2026-W52", "2026-W53", "2027-W01"]);
    expect([...allowedWeeks(Date.UTC(2025, 0, 1))].sort()).toEqual(["2024-W52", "2025-W01", "2025-W02"]);
  });
});

describe("validateReport", () => {
  it("accepts the contract example", () => {
    const r = validateReport(baseBody(), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.report.month).toBe("2026-09");
      expect(r.report.byProvider).toHaveLength(2);
    }
  });
  it("accepts a missing byProvider", () => {
    const r = validateReport(baseBody({ byProvider: undefined }), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.report.byProvider).toEqual([]);
  });
  it("week slice is optional: absent (or all null) → null, present → parsed and rounded", () => {
    const absent = validateReport(baseBody(), NOW);
    expect(absent.ok && absent.report.week).toBeNull();
    const nulls = validateReport(baseBody({ week: null, weekUSD: null, weekTokens: null, weekCalls: null }), NOW);
    expect(nulls.ok && nulls.report.week).toBeNull();

    const present = validateReport(
      baseBody({ week: "2026-W36", weekUSD: 1200.5, weekTokens: 40_000_000.4, weekCalls: 999.6 }),
      NOW,
    );
    expect(present.ok).toBe(true);
    if (present.ok) {
      expect(present.report.week).toEqual({ week: "2026-W36", weekUSD: 1200.5, weekTokens: 40_000_000, weekCalls: 1000, weekOutputTokens: null });
    }
    // neighbouring weeks are tolerated (client local time vs server UTC)
    expect(validateReport(baseBody({ week: "2026-W35", weekUSD: 1, weekTokens: 1, weekCalls: 1 }), NOW).ok).toBe(true);
    expect(validateReport(baseBody({ week: "2026-W37", weekUSD: 1, weekTokens: 1, weekCalls: 1 }), NOW).ok).toBe(true);
  });
  it.each([
    ["partial week fields", { week: "2026-W36", weekUSD: 1 }],
    ["partial week fields (numbers only)", { weekUSD: 1, weekTokens: 1, weekCalls: 1 }],
    ["bad week format", { week: "2026-36", weekUSD: 1, weekTokens: 1, weekCalls: 1 }],
    ["bad week format (lowercase w)", { week: "2026-w36", weekUSD: 1, weekTokens: 1, weekCalls: 1 }],
    ["week out of range", { week: "2026-W54", weekUSD: 1, weekTokens: 1, weekCalls: 1 }],
    ["stale week", { week: "2026-W30", weekUSD: 1, weekTokens: 1, weekCalls: 1 }],
    ["negative weekUSD", { week: "2026-W36", weekUSD: -1, weekTokens: 1, weekCalls: 1 }],
    ["non-numeric weekTokens", { week: "2026-W36", weekUSD: 1, weekTokens: "1", weekCalls: 1 }],
    ["infinite weekCalls", { week: "2026-W36", weekUSD: 1, weekTokens: 1, weekCalls: Number.POSITIVE_INFINITY }],
  ])("rejects %s", (_label, overrides) => {
    const r = validateReport(baseBody(overrides), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/week/);
  });
  it.each([
    ["month", "2026-13"],
    ["month", "2026-9"],
    ["month", 202609],
    ["month", "2020-01"],
    ["monthUSD", -1],
    ["monthUSD", "5"],
    ["monthUSD", Number.POSITIVE_INFINITY],
    ["lifetimeTokens", Number.NaN],
    ["lifetimeCalls", undefined],
    ["byProvider", "claude"],
    ["byProvider", [{ id: "claude" }]],
    ["byProvider", [{ id: "bad id!", monthUSD: 1, lifetimeUSD: 1 }]],
    ["byProvider", [{ id: "claude", monthUSD: 1, lifetimeUSD: 1 }, { id: "claude", monthUSD: 1, lifetimeUSD: 1 }]],
    ["appVersion", ""],
    ["appVersion", 12],
    ["reportedAt", "yesterday"],
    ["reportedAt", 0],
  ])("rejects bad %s = %j", (field, value) => {
    const r = validateReport(baseBody({ [field]: value }), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(field);
  });
  it("rejects non-object bodies", () => {
    expect(validateReport(null, NOW).ok).toBe(false);
    expect(validateReport([], NOW).ok).toBe(false);
    expect(validateReport("x", NOW).ok).toBe(false);
  });
});

describe("evaluateReport — hard rejections (422)", () => {
  it("monthUSD > lifetimeUSD beyond 1% tolerance", () => {
    const within = evaluateReport(validReport({ monthUSD: 100, lifetimeUSD: 99.5 }), null, NOW);
    expect(within.verdict).toBe("accept");
    const beyond = evaluateReport(validReport({ monthUSD: 100, lifetimeUSD: 98 }), null, NOW);
    expect(beyond.verdict).toBe("reject");
  });
  it("monthTokens > lifetimeTokens", () => {
    const r = evaluateReport(validReport({ monthTokens: 10, lifetimeTokens: 9 }), null, NOW);
    expect(r.verdict).toBe("reject");
  });
  it("weekUSD is bounded by lifetimeUSD (+1%) but not by monthUSD", () => {
    const week = (usd: number, tokens = 1) => ({ week: "2026-W36", weekUSD: usd, weekTokens: tokens, weekCalls: 1, weekOutputTokens: null });
    // a calendar week straddling two months can out-spend the current month
    const aboveMonth = evaluateReport(validReport({ monthUSD: 10, lifetimeUSD: 100, week: week(50) }), null, NOW);
    expect(aboveMonth.verdict).toBe("accept");
    const within = evaluateReport(validReport({ monthUSD: 10, lifetimeUSD: 99.5, week: week(100) }), null, NOW);
    expect(within.verdict).toBe("accept");
    const beyond = evaluateReport(validReport({ monthUSD: 10, lifetimeUSD: 98, week: week(100) }), null, NOW);
    expect(beyond.verdict).toBe("reject");
    if (beyond.verdict === "reject") expect(beyond.message).toMatch(/weekUSD/);
  });
  it("weekTokens > lifetimeTokens", () => {
    const r = evaluateReport(
      validReport({ monthTokens: 1, lifetimeTokens: 9, week: { week: "2026-W36", weekUSD: 1, weekTokens: 10, weekCalls: 1, weekOutputTokens: null } }),
      null,
      NOW,
    );
    expect(r.verdict).toBe("reject");
    if (r.verdict === "reject") expect(r.message).toMatch(/weekTokens/);
  });
  it("lifetimeUSD dropping more than 10%", () => {
    const prev = { lifetimeUsd: 1000, lastReportAtMs: NOW - 3_600_000 };
    expect(evaluateReport(validReport({ lifetimeUSD: 905, monthUSD: 1 }), prev, NOW).verdict).toBe("accept");
    expect(evaluateReport(validReport({ lifetimeUSD: 899, monthUSD: 1 }), prev, NOW).verdict).toBe("reject");
  });
});

describe("evaluateReport — soft flags", () => {
  it("first report is never growth-capped", () => {
    const r = evaluateReport(validReport({ lifetimeUSD: 1_000_000, lifetimeTokens: 100_000_000_000 }), null, NOW);
    expect(r).toEqual({ verdict: "accept", flagged: false, reasons: [] });
  });
  it("growth cap: 3000 USD × max(1, hours/24) + 500", () => {
    const prev = { lifetimeUsd: 1000, lastReportAtMs: NOW - 3_600_000 }; // 1h ago → cap 3500
    const ok = evaluateReport(validReport({ lifetimeUSD: 4500, monthUSD: 1, lifetimeTokens: 1_000_000_000 }), prev, NOW);
    expect(ok).toMatchObject({ verdict: "accept", flagged: false });
    const bad = evaluateReport(validReport({ lifetimeUSD: 4501, monthUSD: 1, lifetimeTokens: 1_000_000_000 }), prev, NOW);
    expect(bad).toMatchObject({ verdict: "accept", flagged: true });
    if (bad.verdict === "accept") expect(bad.reasons[0]).toMatch(/growth_cap/);
  });
  it("growth cap scales with elapsed days", () => {
    const prev = { lifetimeUsd: 1000, lastReportAtMs: NOW - 48 * 3_600_000 }; // 2 days → cap 6500
    const ok = evaluateReport(validReport({ lifetimeUSD: 7500, monthUSD: 1, lifetimeTokens: 1_000_000_000 }), prev, NOW);
    expect(ok).toMatchObject({ verdict: "accept", flagged: false });
    const bad = evaluateReport(validReport({ lifetimeUSD: 7501, monthUSD: 1, lifetimeTokens: 1_000_000_000 }), prev, NOW);
    expect(bad).toMatchObject({ verdict: "accept", flagged: true });
  });
  it("cost per 1M tokens must be within [0.02, 300]", () => {
    // 1000 USD / 1M tokens = 1000 USD per 1M → too expensive
    const expensive = evaluateReport(validReport({ lifetimeUSD: 1000, monthUSD: 1, lifetimeTokens: 1_000_000, monthTokens: 0 }), null, NOW);
    expect(expensive).toMatchObject({ verdict: "accept", flagged: true });
    if (expensive.verdict === "accept") expect(expensive.reasons[0]).toMatch(/cost_per_token/);
    // 1 USD / 1e9 tokens = 0.001 per 1M → too cheap
    const cheap = evaluateReport(validReport({ lifetimeUSD: 1, monthUSD: 1, lifetimeTokens: 1_000_000_000 }), null, NOW);
    expect(cheap).toMatchObject({ verdict: "accept", flagged: true });
    // exactly at the edges is fine
    const lo = evaluateReport(validReport({ lifetimeUSD: 0.02, monthUSD: 0.01, lifetimeTokens: 1_000_000, monthTokens: 0 }), null, NOW);
    expect(lo).toMatchObject({ flagged: false });
    const hi = evaluateReport(validReport({ lifetimeUSD: 300, monthUSD: 1, lifetimeTokens: 1_000_000, monthTokens: 0 }), null, NOW);
    expect(hi).toMatchObject({ flagged: false });
    // zero tokens → rule not applied
    const zero = evaluateReport(validReport({ lifetimeUSD: 5, monthUSD: 1, lifetimeTokens: 0, monthTokens: 0 }), null, NOW);
    expect(zero).toMatchObject({ flagged: false });
  });
});

describe("validateReport — metric fields", () => {
  it("absent metric fields parse as null", () => {
    const r = validateReport(baseBody(), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.report.monthOutputTokens).toBeNull();
      expect(r.report.lifetimeOutputTokens).toBeNull();
      expect(r.report.streakDays).toBeNull();
      expect(r.report.activeDays).toBeNull();
    }
  });
  it("present metric fields are rounded and attached (weekOutputTokens to the week slice)", () => {
    const r = validateReport(
      baseBody({
        week: "2026-W36", weekUSD: 10, weekTokens: 1_000_000, weekCalls: 10, weekOutputTokens: 200_000.4,
        monthOutputTokens: 5_000_000.6, lifetimeOutputTokens: 40_000_000, streakDays: 12.2, activeDays: 90,
      }),
      NOW,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.report.week?.weekOutputTokens).toBe(200_000);
      expect(r.report.monthOutputTokens).toBe(5_000_001);
      expect(r.report.lifetimeOutputTokens).toBe(40_000_000);
      expect(r.report.streakDays).toBe(12);
      expect(r.report.activeDays).toBe(90);
    }
  });
  it.each([
    ["monthOutputTokens", { monthOutputTokens: -1 }],
    ["lifetimeOutputTokens", { lifetimeOutputTokens: "many" }],
    ["streakDays", { streakDays: Number.NaN }],
    ["streakDays", { streakDays: 3661 }],
    ["activeDays", { streakDays: 10, activeDays: 9 }],
    ["weekOutputTokens", { weekOutputTokens: 5 }], // without the week fields
  ])("rejects bad %s", (field, overrides) => {
    const r = validateReport(baseBody(overrides), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(field);
  });
  it("streak bounds: 0 and 3660 are fine, activeDays may equal streakDays", () => {
    expect(validateReport(baseBody({ streakDays: 0, activeDays: 0 }), NOW).ok).toBe(true);
    expect(validateReport(baseBody({ streakDays: 3660, activeDays: 3660 }), NOW).ok).toBe(true);
    expect(validateReport(baseBody({ activeDays: 5 }), NOW).ok).toBe(true);
  });
});

describe("evaluateReport — metric plausibility", () => {
  it("output tokens may not exceed the period's total tokens (422)", () => {
    const ok = evaluateReport(validReport({ monthOutputTokens: 166_300_000, lifetimeOutputTokens: 500_000_000 }), null, NOW);
    expect(ok.verdict).toBe("accept");
    const month = evaluateReport(validReport({ monthOutputTokens: 166_300_001 }), null, NOW);
    expect(month).toMatchObject({ verdict: "reject" });
    if (month.verdict === "reject") expect(month.message).toMatch(/monthOutputTokens/);
    const life = evaluateReport(validReport({ lifetimeOutputTokens: 500_000_001 }), null, NOW);
    expect(life.verdict).toBe("reject");
    const week = evaluateReport(
      validReport({ week: { week: "2026-W36", weekUSD: 1, weekTokens: 10, weekCalls: 1, weekOutputTokens: 11 } }),
      null,
      NOW,
    );
    expect(week).toMatchObject({ verdict: "reject" });
    if (week.verdict === "reject") expect(week.message).toMatch(/weekOutputTokens/);
  });
  it("streak / active days may grow by at most (days elapsed + 1) since the previous report", () => {
    const prev = { lifetimeUsd: 31000, lastReportAtMs: NOW - 3_600_000, streakDays: 10, activeDays: 50 }; // 1h → +1
    expect(evaluateReport(validReport({ streakDays: 11, activeDays: 51 }), prev, NOW)).toMatchObject({ flagged: false });
    const streak = evaluateReport(validReport({ streakDays: 12, activeDays: 51 }), prev, NOW);
    expect(streak).toMatchObject({ verdict: "accept", flagged: true });
    if (streak.verdict === "accept") expect(streak.reasons[0]).toMatch(/streak_growth/);
    const active = evaluateReport(validReport({ streakDays: 11, activeDays: 52 }), prev, NOW);
    expect(active).toMatchObject({ flagged: true });
    if (active.verdict === "accept") expect(active.reasons[0]).toMatch(/active_days_growth/);

    // 3 days later → +4 allowed; a broken streak (drop) is always fine
    const later = { ...prev, lastReportAtMs: NOW - 3 * 24 * 3_600_000 };
    expect(evaluateReport(validReport({ streakDays: 14, activeDays: 54 }), later, NOW)).toMatchObject({ flagged: false });
    expect(evaluateReport(validReport({ streakDays: 15, activeDays: 54 }), later, NOW)).toMatchObject({ flagged: true });
    expect(evaluateReport(validReport({ streakDays: 1, activeDays: 50 }), later, NOW)).toMatchObject({ flagged: false });
    // absent fields are never judged; a first report is never capped
    expect(evaluateReport(validReport(), prev, NOW)).toMatchObject({ flagged: false });
    expect(evaluateReport(validReport({ streakDays: 3000, activeDays: 3000 }), null, NOW)).toMatchObject({ flagged: false });
  });
});

describe("rateLimitRetryAfter", () => {
  it("allows the first report and reports after 10 minutes", () => {
    expect(rateLimitRetryAfter(null, NOW)).toBe(0);
    expect(rateLimitRetryAfter(NOW - 10 * 60_000, NOW)).toBe(0);
  });
  it("returns the remaining seconds, rounded up, minimum 1", () => {
    expect(rateLimitRetryAfter(NOW - 9 * 60_000, NOW)).toBe(60);
    expect(rateLimitRetryAfter(NOW - 9 * 60_000 - 59_500, NOW)).toBe(1);
    expect(rateLimitRetryAfter(NOW, NOW)).toBe(600);
  });
});

describe("topProvider", () => {
  it("returns null with no split, else the max for the key", () => {
    expect(topProvider([], "monthUSD")).toBeNull();
    const split = [
      { id: "claude", monthUSD: 10, lifetimeUSD: 100 },
      { id: "codex", monthUSD: 20, lifetimeUSD: 50 },
    ];
    expect(topProvider(split, "monthUSD")).toBe("codex");
    expect(topProvider(split, "lifetimeUSD")).toBe("claude");
  });
});
