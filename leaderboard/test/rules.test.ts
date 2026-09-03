import { describe, expect, it } from "vitest";
import {
  allowedMonths,
  evaluateReport,
  rateLimitRetryAfter,
  topProvider,
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
