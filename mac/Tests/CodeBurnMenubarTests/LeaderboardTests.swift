import Foundation
import Testing
@testable import CodeBurnMenubar

/// Pure-logic coverage for the leaderboard client: report totals and
/// validation, the GitHub device-flow response parsing, the API JSON shapes,
/// the version gate, and HTTP status mapping. No network, no Keychain.
@Suite("Leaderboard")
struct LeaderboardTests {

    // MARK: Fixtures

    private static func payloadJSON(
        cost: Double,
        calls: Int,
        input: Int,
        output: Int,
        cacheRead: Int? = nil,
        cacheWrite: Int? = nil,
        providerDetails: String = "[]",
        providers: String = "{}",
        daily: String = "[]"
    ) -> Data {
        var current = """
        "label": "Month", "cost": \(cost), "calls": \(calls), "sessions": 3,
        "inputTokens": \(input), "outputTokens": \(output), "cacheHitPercent": 12.5,
        "providers": \(providers), "providerDetails": \(providerDetails)
        """
        if let cacheRead { current += ", \"cacheReadTokens\": \(cacheRead)" }
        if let cacheWrite { current += ", \"cacheWriteTokens\": \(cacheWrite)" }
        return """
        {
          "generated": "2026-09-03T04:00:00Z",
          "current": { \(current) },
          "optimize": { "findingCount": 0, "savingsUSD": 0, "topFindings": [] },
          "history": { "daily": \(daily) }
        }
        """.data(using: .utf8)!
    }

    /// One `history.daily` row as the CLI emits it (local `yyyy-MM-dd` key).
    private static func dailyJSON(
        _ date: String, cost: Double, calls: Int,
        input: Int, output: Int, cacheRead: Int, cacheWrite: Int
    ) -> String {
        """
        {"date":"\(date)","cost":\(cost),"savingsUSD":0,"calls":\(calls),"inputTokens":\(input),"outputTokens":\(output),"cacheReadTokens":\(cacheRead),"cacheWriteTokens":\(cacheWrite)}
        """
    }

    private static func utc(_ iso: String) -> Date {
        ISO8601DateFormatter().date(from: iso)!
    }

    /// Gregorian calendar in `zone` with a Sunday-first week (the en_US
    /// default), so the tests prove the builder imposes ISO Monday weeks.
    private static func calendar(_ zone: String) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: zone)!
        calendar.firstWeekday = 1
        calendar.minimumDaysInFirstWeek = 1
        return calendar
    }

    private static func decode(_ data: Data) throws -> MenubarPayload {
        try JSONDecoder().decode(MenubarPayload.self, from: data)
    }

    private static let reportedAt = Date(timeIntervalSince1970: 1788177600) // 2026-08-31T12:00:00Z

    // MARK: Totals from payload

    @Test("totals sum input, output and both cache token counts")
    func totalsIncludeCacheTokens() throws {
        let payload = try Self.decode(Self.payloadJSON(
            cost: 5849.91, calls: 4173, input: 100_000_000, output: 6_300_000,
            cacheRead: 50_000_000, cacheWrite: 10_000_000))
        let totals = LeaderboardReportBuilder.totals(from: payload)

        #expect(totals.usd == 5849.91)
        #expect(totals.calls == 4173)
        #expect(totals.tokens == 166_300_000)
        #expect(totals.outputTokens == 6_300_000)
        #expect(totals.providers.isEmpty)
    }

    @Test("cache token fields default to zero on payloads from older CLIs")
    func cacheTokensDefaultToZero() throws {
        let payload = try Self.decode(Self.payloadJSON(cost: 1, calls: 1, input: 10, output: 5))
        #expect(payload.current.cacheReadTokens == 0)
        #expect(payload.current.cacheWriteTokens == 0)
        #expect(LeaderboardReportBuilder.totals(from: payload).tokens == 15)
    }

    @Test("provider split prefers providerDetails ids and drops zero-cost rows")
    func providerSplitFromDetails() throws {
        let payload = try Self.decode(Self.payloadJSON(
            cost: 10, calls: 1, input: 1, output: 1,
            providerDetails: """
            [{"id":"Claude","label":"Claude","cost":7.5,"calls":3,"hasUsage":true},
             {"id":"cursor agent","label":"Cursor Agent","cost":2.5,"calls":1,"hasUsage":true},
             {"id":"copilot","label":"Copilot","cost":0,"calls":0,"hasUsage":true}]
            """,
            providers: "{\"gemini\": 99}"))
        let split = LeaderboardReportBuilder.totals(from: payload).providers

        #expect(split == ["claude": 7.5, "cursor-agent": 2.5])
    }

    @Test("provider split falls back to the legacy providers map")
    func providerSplitFromLegacyMap() throws {
        let payload = try Self.decode(Self.payloadJSON(
            cost: 10, calls: 1, input: 1, output: 1,
            providers: "{\"Codex\": 4.0, \"claude\": 6.0, \"kimi\": 0}"))
        let split = LeaderboardReportBuilder.totals(from: payload).providers

        #expect(split == ["codex": 4.0, "claude": 6.0])
    }

    // MARK: Report building

    @Test("builds the contract report from month and lifetime totals")
    func buildsReport() throws {
        let month = LeaderboardReportBuilder.Totals(
            usd: 5849.91, tokens: 166_300_000, calls: 4173,
            providers: ["claude": 5000.0, "codex": 849.91])
        let lifetime = LeaderboardReportBuilder.Totals(
            usd: 31922.22, tokens: 500_000_000, calls: 73150,
            providers: ["claude": 31330.98, "codex": 500.0, "cursor": 91.24])

        let report = try LeaderboardReportBuilder.build(
            month: month, lifetime: lifetime, monthKey: "2026-09",
            appVersion: "0.9.23-zh4", reportedAt: Self.reportedAt)

        #expect(report.month == "2026-09")
        #expect(report.monthUSD == 5849.91)
        #expect(report.monthTokens == 166_300_000)
        #expect(report.monthCalls == 4173)
        #expect(report.lifetimeUSD == 31922.22)
        #expect(report.lifetimeTokens == 500_000_000)
        #expect(report.lifetimeCalls == 73150)
        #expect(report.appVersion == "0.9.23-zh4")
        #expect(report.reportedAt == "2026-08-31T12:00:00Z")

        let split = try #require(report.byProvider)
        #expect(split.map(\.id) == ["claude", "codex", "cursor"])
        #expect(split[0].monthUSD == 5000.0 && split[0].lifetimeUSD == 31330.98)
        // codex: month 849.91 exceeds the lifetime 500.0 the other fetch saw; lifetime is lifted.
        #expect(split[1].monthUSD == 849.91 && split[1].lifetimeUSD == 849.91)
        #expect(split[2].monthUSD == 0 && split[2].lifetimeUSD == 91.24)
    }

    @Test("lifetime never reads below month when the two fetches raced")
    func liftsLifetimeToMonth() throws {
        let report = try LeaderboardReportBuilder.build(
            month: .init(usd: 120, tokens: 2_000, calls: 30),
            lifetime: .init(usd: 118, tokens: 1_900, calls: 29),
            monthKey: "2026-09", appVersion: "dev", reportedAt: Self.reportedAt)

        #expect(report.lifetimeUSD == 120)
        #expect(report.lifetimeTokens == 2_000)
        #expect(report.lifetimeCalls == 30)
    }

    @Test("byProvider is omitted from the JSON when there is no split")
    func omitsEmptyProviderSplit() throws {
        let report = try LeaderboardReportBuilder.build(
            month: .init(usd: 1, tokens: 1, calls: 1),
            lifetime: .init(usd: 2, tokens: 2, calls: 2),
            monthKey: "2026-09", appVersion: "dev", reportedAt: Self.reportedAt)
        #expect(report.byProvider == nil)

        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(report)) as? [String: Any]
        let keys = try #require(json).keys.sorted()
        #expect(keys == ["activeDays", "appVersion", "lifetimeCalls", "lifetimeOutputTokens", "lifetimeTokens", "lifetimeUSD",
                         "month", "monthCalls", "monthOutputTokens", "monthTokens", "monthUSD", "reportedAt", "streakDays"])
        #expect(report.monthOutputTokens == 0 && report.lifetimeOutputTokens == 0)
        #expect(report.streakDays == 0 && report.activeDays == 0)
    }

    @Test("rejects non-finite and negative numbers")
    func rejectsImplausibleNumbers() {
        #expect(throws: LeaderboardReportBuilder.BuildError.notFinite("monthUSD")) {
            try LeaderboardReportBuilder.build(
                month: .init(usd: .nan, tokens: 0, calls: 0),
                lifetime: .init(usd: 0, tokens: 0, calls: 0),
                monthKey: "2026-09", appVersion: "dev", reportedAt: Self.reportedAt)
        }
        #expect(throws: LeaderboardReportBuilder.BuildError.negative("lifetimeUSD")) {
            try LeaderboardReportBuilder.build(
                month: .init(usd: 0, tokens: 0, calls: 0),
                lifetime: .init(usd: -1, tokens: 0, calls: 0),
                monthKey: "2026-09", appVersion: "dev", reportedAt: Self.reportedAt)
        }
        #expect(throws: LeaderboardReportBuilder.BuildError.negative("monthTokens")) {
            try LeaderboardReportBuilder.build(
                month: .init(usd: 0, tokens: -5, calls: 0),
                lifetime: .init(usd: 0, tokens: 0, calls: 0),
                monthKey: "2026-09", appVersion: "dev", reportedAt: Self.reportedAt)
        }
    }

    @Test("month key is the local calendar month as YYYY-MM")
    func monthKey() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        // 2026-08-31T22:00:00Z is already September 1 in Shanghai.
        let date = Date(timeIntervalSince1970: 1788213600)
        #expect(LeaderboardReportBuilder.monthKey(for: date, calendar: calendar) == "2026-09")

        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0)!
        #expect(LeaderboardReportBuilder.monthKey(for: date, calendar: utc) == "2026-08")
    }

    // MARK: Week (local ISO calendar week)

    @Test("week key is the local ISO week as YYYY-Www")
    func weekKey() {
        let shanghai = Self.calendar("Asia/Shanghai")
        // Thursday 2026-09-03 12:00 CST
        #expect(LeaderboardReportBuilder.weekKey(for: Self.utc("2026-09-03T04:00:00Z"), calendar: shanghai) == "2026-W36")
        // Sunday still belongs to the Monday-start week (a Sunday-first calendar would say W37)
        #expect(LeaderboardReportBuilder.weekKey(for: Self.utc("2026-09-06T04:00:00Z"), calendar: shanghai) == "2026-W36")
        // Sunday 20:00 UTC is already Monday 04:00 in Shanghai.
        #expect(LeaderboardReportBuilder.weekKey(for: Self.utc("2026-09-06T20:00:00Z"), calendar: shanghai) == "2026-W37")
        #expect(LeaderboardReportBuilder.weekKey(for: Self.utc("2026-09-06T20:00:00Z"), calendar: Self.calendar("UTC")) == "2026-W36")
    }

    @Test("week key follows the ISO year-boundary rules")
    func weekKeyYearBoundary() {
        let utc = Self.calendar("UTC")
        func key(_ iso: String) -> String { LeaderboardReportBuilder.weekKey(for: Self.utc(iso), calendar: utc) }
        #expect(key("2027-01-01T12:00:00Z") == "2026-W53") // Friday; 2026 has 53 ISO weeks
        #expect(key("2027-01-03T12:00:00Z") == "2026-W53") // Sunday
        #expect(key("2027-01-04T12:00:00Z") == "2027-W01") // Monday
        #expect(key("2024-12-30T12:00:00Z") == "2025-W01") // Monday before New Year belongs to the new ISO year
        #expect(key("2021-01-03T12:00:00Z") == "2020-W53")
        #expect(key("2021-01-04T12:00:00Z") == "2021-W01")
    }

    @Test("week starts on the local Monday at 00:00")
    func weekStart() {
        let shanghai = Self.calendar("Asia/Shanghai")
        let monday = Self.utc("2026-08-30T16:00:00Z") // 2026-08-31 00:00 CST
        #expect(LeaderboardReportBuilder.weekStart(for: Self.utc("2026-09-03T04:00:00Z"), calendar: shanghai) == monday) // Thursday
        #expect(LeaderboardReportBuilder.weekStart(for: Self.utc("2026-09-06T04:00:00Z"), calendar: shanghai) == monday) // Sunday
        #expect(LeaderboardReportBuilder.weekStart(for: Self.utc("2026-08-30T16:30:00Z"), calendar: shanghai) == monday) // Monday 00:30
        #expect(LeaderboardReportBuilder.weekStart(for: Self.utc("2026-08-30T15:30:00Z"), calendar: shanghai)
                == Self.utc("2026-08-23T16:00:00Z")) // Sunday 23:30: previous week
        #expect(LeaderboardReportBuilder.dayKey(monday, calendar: shanghai) == "2026-08-31")
        #expect(LeaderboardReportBuilder.dayKey(monday, calendar: Self.calendar("UTC")) == "2026-08-30")
    }

    @Test("week totals sum the daily series from Monday through today, cache tokens included")
    func weekTotals() throws {
        let daily = "[" + [
            Self.dailyJSON("2026-08-29", cost: 50, calls: 5, input: 100, output: 10, cacheRead: 1, cacheWrite: 1),  // Saturday, last week
            Self.dailyJSON("2026-08-30", cost: 10, calls: 1, input: 100, output: 10, cacheRead: 1, cacheWrite: 1),  // Sunday, last week
            Self.dailyJSON("2026-08-31", cost: 1.5, calls: 3, input: 1_000, output: 100, cacheRead: 5_000, cacheWrite: 200), // Monday
            Self.dailyJSON("2026-09-02", cost: 2.25, calls: 4, input: 2_000, output: 200, cacheRead: 6_000, cacheWrite: 300),
            Self.dailyJSON("2026-09-03", cost: 4, calls: 5, input: 3_000, output: 300, cacheRead: 7_000, cacheWrite: 400),   // today
            Self.dailyJSON("2026-09-04", cost: 100, calls: 9, input: 9, output: 9, cacheRead: 9, cacheWrite: 9),   // tomorrow, ignored
        ].joined(separator: ",") + "]"
        // `current` is the 30-day block and must not leak into the week.
        let payload = try Self.decode(Self.payloadJSON(cost: 999, calls: 999, input: 1, output: 1, daily: daily))
        let totals = LeaderboardReportBuilder.weekTotals(
            from: payload, now: Self.utc("2026-09-03T04:00:00Z"), calendar: Self.calendar("Asia/Shanghai"))

        #expect(totals.usd == 7.75)
        #expect(totals.calls == 12)
        #expect(totals.tokens == 6_000 + 600 + 18_000 + 900)
        #expect(totals.outputTokens == 600)
        #expect(totals.providers.isEmpty)

        // Monday itself: only that day counts.
        let mondayOnly = LeaderboardReportBuilder.weekTotals(
            from: payload, now: Self.utc("2026-08-30T17:00:00Z"), calendar: Self.calendar("Asia/Shanghai"))
        #expect(mondayOnly.usd == 1.5 && mondayOnly.calls == 3)

        // An empty series is a zero week, not an error.
        let empty = try Self.decode(Self.payloadJSON(cost: 5, calls: 1, input: 1, output: 1))
        #expect(LeaderboardReportBuilder.weekTotals(from: empty, now: Self.reportedAt) == .init(usd: 0, tokens: 0, calls: 0))
    }

    @Test("report carries the week slice, lifts lifetime above it, and validates it")
    func buildsReportWithWeek() throws {
        let report = try LeaderboardReportBuilder.build(
            month: .init(usd: 100, tokens: 1_000, calls: 10),
            lifetime: .init(usd: 118, tokens: 1_900, calls: 29),
            monthKey: "2026-09",
            week: .init(usd: 120, tokens: 2_000, calls: 30), // a week straddling the month boundary
            weekKey: "2026-W36",
            appVersion: "dev", reportedAt: Self.reportedAt)

        #expect(report.week == "2026-W36")
        #expect(report.weekUSD == 120)
        #expect(report.weekTokens == 2_000)
        #expect(report.weekCalls == 30)
        #expect(report.monthUSD == 100, "the month is never lifted to the week")
        #expect(report.lifetimeUSD == 120)
        #expect(report.lifetimeTokens == 2_000)
        #expect(report.lifetimeCalls == 30)

        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(report)) as? [String: Any]
        let keys = try #require(json).keys.sorted()
        #expect(keys == ["activeDays", "appVersion", "lifetimeCalls", "lifetimeOutputTokens", "lifetimeTokens", "lifetimeUSD",
                         "month", "monthCalls", "monthOutputTokens", "monthTokens", "monthUSD", "reportedAt", "streakDays",
                         "week", "weekCalls", "weekOutputTokens", "weekTokens", "weekUSD"])

        // Totals without a key (or vice versa) ship no week at all.
        let keyless = try LeaderboardReportBuilder.build(
            month: .init(usd: 1, tokens: 1, calls: 1), lifetime: .init(usd: 2, tokens: 2, calls: 2),
            monthKey: "2026-09", week: .init(usd: 1, tokens: 1, calls: 1), weekKey: nil,
            appVersion: "dev", reportedAt: Self.reportedAt)
        #expect(keyless.week == nil && keyless.weekUSD == nil && keyless.weekTokens == nil && keyless.weekCalls == nil)

        #expect(throws: LeaderboardReportBuilder.BuildError.negative("weekUSD")) {
            try LeaderboardReportBuilder.build(
                month: .init(usd: 0, tokens: 0, calls: 0), lifetime: .init(usd: 0, tokens: 0, calls: 0),
                monthKey: "2026-09", week: .init(usd: -1, tokens: 0, calls: 0), weekKey: "2026-W36",
                appVersion: "dev", reportedAt: Self.reportedAt)
        }
        #expect(throws: LeaderboardReportBuilder.BuildError.notFinite("weekUSD")) {
            try LeaderboardReportBuilder.build(
                month: .init(usd: 0, tokens: 0, calls: 0), lifetime: .init(usd: 0, tokens: 0, calls: 0),
                monthKey: "2026-09", week: .init(usd: .infinity, tokens: 0, calls: 0), weekKey: "2026-W36",
                appVersion: "dev", reportedAt: Self.reportedAt)
        }
    }

    // MARK: Streak / activity

    private static func activityDaily(_ days: [(String, Int)]) -> [DailyHistoryEntry] {
        let json = "[" + days.map { Self.dailyJSON($0.0, cost: 1, calls: $0.1, input: 10, output: 5, cacheRead: 0, cacheWrite: 0) }
            .joined(separator: ",") + "]"
        return (try? Self.decode(Self.payloadJSON(cost: 1, calls: 1, input: 1, output: 1, daily: json)))?.history.daily ?? []
    }

    @Test("streak counts consecutive active days ending today")
    func streakEndingToday() {
        let daily = Self.activityDaily([("2026-08-30", 2), ("2026-08-31", 1), ("2026-09-01", 4), ("2026-09-02", 1), ("2026-09-03", 3)])
        let activity = LeaderboardReportBuilder.activity(
            from: daily, now: Self.utc("2026-09-03T04:00:00Z"), calendar: Self.calendar("Asia/Shanghai"))
        #expect(activity == .init(streakDays: 5, activeDays: 5))
    }

    @Test("a gap breaks the streak; a zero-call day is neither active nor part of it")
    func streakGap() {
        let daily = Self.activityDaily([("2026-08-28", 1), ("2026-08-29", 1), ("2026-08-30", 0), ("2026-08-31", 1), ("2026-09-01", 1), ("2026-09-02", 1), ("2026-09-03", 1)])
        let activity = LeaderboardReportBuilder.activity(
            from: daily, now: Self.utc("2026-09-03T04:00:00Z"), calendar: Self.calendar("Asia/Shanghai"))
        #expect(activity.streakDays == 4)
        #expect(activity.activeDays == 6)
    }

    @Test("today without calls yet keeps yesterday's streak alive; two idle days end it")
    func streakTodayIdle() {
        let calendar = Self.calendar("Asia/Shanghai")
        let daily = Self.activityDaily([("2026-08-31", 1), ("2026-09-01", 1), ("2026-09-02", 1)])
        // Thursday 09-03 with nothing logged yet → the run ending Wednesday still counts.
        #expect(LeaderboardReportBuilder.activity(from: daily, now: Self.utc("2026-09-03T04:00:00Z"), calendar: calendar).streakDays == 3)
        // Friday 09-04: Thursday was idle, so the streak is over.
        #expect(LeaderboardReportBuilder.activity(from: daily, now: Self.utc("2026-09-04T04:00:00Z"), calendar: calendar).streakDays == 0)
        // Sunday 20:00 UTC is Monday in Shanghai but still Sunday in UTC: the day key follows the calendar.
        let sundayUTC = Self.activityDaily([("2026-09-06", 1)])
        #expect(LeaderboardReportBuilder.activity(from: sundayUTC, now: Self.utc("2026-09-06T20:00:00Z"), calendar: Self.calendar("UTC")).streakDays == 1)
        #expect(LeaderboardReportBuilder.activity(from: sundayUTC, now: Self.utc("2026-09-06T20:00:00Z"), calendar: calendar).streakDays == 1)
    }

    @Test("a series shorter than the true streak caps it at the series length; empty series is zero")
    func streakCappedBySeries() {
        let calendar = Self.calendar("Asia/Shanghai")
        let short = Self.activityDaily([("2026-09-01", 1), ("2026-09-02", 1), ("2026-09-03", 1)])
        #expect(LeaderboardReportBuilder.activity(from: short, now: Self.utc("2026-09-03T04:00:00Z"), calendar: calendar) == .init(streakDays: 3, activeDays: 3))
        #expect(LeaderboardReportBuilder.activity(from: [], now: Self.utc("2026-09-03T04:00:00Z"), calendar: calendar) == .none)
    }

    @Test("report carries output tokens per period and the activity, lifting lifetime output and active days")
    func buildsReportWithMetrics() throws {
        let report = try LeaderboardReportBuilder.build(
            month: .init(usd: 100, tokens: 1_000, calls: 10, outputTokens: 300),
            lifetime: .init(usd: 118, tokens: 1_900, calls: 29, outputTokens: 250), // raced: below the month
            monthKey: "2026-09",
            week: .init(usd: 20, tokens: 500, calls: 5, outputTokens: 120),
            weekKey: "2026-W36",
            activity: .init(streakDays: 12, activeDays: 9), // impossible: lifted
            appVersion: "dev", reportedAt: Self.reportedAt)
        #expect(report.monthOutputTokens == 300)
        #expect(report.weekOutputTokens == 120)
        #expect(report.lifetimeOutputTokens == 300)
        #expect(report.streakDays == 12)
        #expect(report.activeDays == 12)

        #expect(throws: LeaderboardReportBuilder.BuildError.negative("streakDays")) {
            try LeaderboardReportBuilder.build(
                month: .init(usd: 0, tokens: 0, calls: 0), lifetime: .init(usd: 0, tokens: 0, calls: 0),
                monthKey: "2026-09", activity: .init(streakDays: -1, activeDays: 0),
                appVersion: "dev", reportedAt: Self.reportedAt)
        }
        #expect(throws: LeaderboardReportBuilder.BuildError.negative("monthOutputTokens")) {
            try LeaderboardReportBuilder.build(
                month: .init(usd: 0, tokens: 0, calls: 0, outputTokens: -1), lifetime: .init(usd: 0, tokens: 0, calls: 0),
                monthKey: "2026-09", appVersion: "dev", reportedAt: Self.reportedAt)
        }
    }

    @Test("metrics are output, usd, streak with spend as the default")
    @MainActor
    func metricOrderAndFormat() {
        #expect(LeaderboardMetric.allCases == [.output, .usd, .streak])
        #expect(LeaderboardMetric.allCases.map(\.rawValue) == ["output", "usd", "streak"])
        #expect(LeaderboardMetric.default == .usd)
        #expect(LeaderboardMetric.output.format(1_234_567) == "1.2M")
        #expect(LeaderboardMetric.output.format(340_000) == "340K")
        #expect(LeaderboardMetric.streak.format(7) == L("\(7) days"))
        #expect(LeaderboardMetric.usd.format(12.5).hasSuffix("12.50") || LeaderboardMetric.usd.format(12.5).contains("."))
    }

    @Test("boards are week, month, lifetime in that order")
    func boardOrder() {
        #expect(LeaderboardBoard.allCases == [.week, .month, .lifetime])
        #expect(LeaderboardBoard.allCases.map(\.rawValue) == ["week", "month", "lifetime"])
    }

    // MARK: Device flow

    @Test("parses the device code response")
    func parsesDeviceCode() throws {
        let body = """
        {"device_code":"3584d83530557fdd1f46af8289938c8ef79f9dc5","user_code":"WDJB-MJHT",
         "verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}
        """.data(using: .utf8)!
        let code = try GitHubDeviceFlow.parseDeviceCode(body)

        #expect(code.deviceCode == "3584d83530557fdd1f46af8289938c8ef79f9dc5")
        #expect(code.userCode == "WDJB-MJHT")
        #expect(code.verificationURL.absoluteString == "https://github.com/login/device")
        #expect(code.expiresIn == 900)
        #expect(code.interval == 5)
    }

    @Test("device code errors surface GitHub's description")
    func deviceCodeError() {
        let body = """
        {"error":"unauthorized_client","error_description":"Device flow is not enabled for this app."}
        """.data(using: .utf8)!
        #expect(throws: LeaderboardError.deviceFlow("Device flow is not enabled for this app.")) {
            try GitHubDeviceFlow.parseDeviceCode(body)
        }
        #expect(throws: LeaderboardError.decodeFailed) {
            try GitHubDeviceFlow.parseDeviceCode(Data("not json".utf8))
        }
    }

    @Test("classifies every device-flow poll outcome")
    func parsesPollOutcomes() {
        func poll(_ json: String) -> GitHubDeviceFlow.PollOutcome {
            GitHubDeviceFlow.parsePoll(Data(json.utf8))
        }
        #expect(poll(#"{"error":"authorization_pending","error_description":"..."}"#) == .pending)
        #expect(poll(#"{"error":"slow_down","interval":10}"#) == .slowDown)
        #expect(poll(#"{"error":"expired_token"}"#) == .expired)
        #expect(poll(#"{"error":"access_denied"}"#) == .denied)
        #expect(poll(#"{"access_token":"gho_16C7e42F292c6912E7710c838347Ae178B4a","token_type":"bearer","scope":""}"#)
                == .accessToken("gho_16C7e42F292c6912E7710c838347Ae178B4a"))
        #expect(poll(#"{"error":"incorrect_device_code","error_description":"The device code is wrong."}"#)
                == .failure("The device code is wrong."))
        if case .failure = poll("garbage") {} else {
            Issue.record("malformed poll body must be a failure")
        }
    }

    @Test("poll and code requests are form-encoded with JSON accept")
    func deviceFlowRequests() throws {
        let code = GitHubDeviceFlow.codeRequest(clientId: "Iv1.abc")
        #expect(code.url == GitHubDeviceFlow.deviceCodeURL)
        #expect(code.httpMethod == "POST")
        #expect(code.value(forHTTPHeaderField: "Accept") == "application/json")
        #expect(code.value(forHTTPHeaderField: "Content-Type") == "application/x-www-form-urlencoded")
        #expect(String(decoding: try #require(code.httpBody), as: UTF8.self) == "client_id=Iv1.abc&scope=")

        let poll = GitHubDeviceFlow.pollRequest(clientId: "Iv1.abc", deviceCode: "dev code")
        #expect(poll.url == GitHubDeviceFlow.accessTokenURL)
        #expect(String(decoding: try #require(poll.httpBody), as: UTF8.self)
                == "client_id=Iv1.abc&device_code=dev%20code&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code")
    }

    // MARK: API JSON

    @Test("decodes the leaderboard page including me")
    func decodesLeaderboardPage() throws {
        let body = """
        { "board": "month", "month": "2026-09", "updatedAt": "2026-09-03T04:00:00Z", "totalUsers": 120,
          "entries": [
            { "rank": 1, "login": "octocat", "avatarUrl": "https://avatars.githubusercontent.com/u/583231",
              "usd": 5849.91, "tokens": 166300000, "calls": 4173, "topProvider": "claude" },
            { "rank": 2, "login": "hubot", "avatarUrl": null, "usd": 120.5, "tokens": 1, "calls": 2, "topProvider": null }
          ],
          "me": { "rank": 12, "usd": 620.5, "tokens": 5000, "calls": 40, "flagged": false } }
        """.data(using: .utf8)!
        let page = try JSONDecoder().decode(LeaderboardPage.self, from: body)

        #expect(page.board == "month")
        #expect(page.month == "2026-09")
        #expect(page.week == nil)
        #expect(page.totalUsers == 120)
        #expect(page.entries.count == 2)
        #expect(page.entries[0].login == "octocat")
        #expect(page.entries[0].usd == 5849.91)
        #expect(page.entries[0].topProvider == "claude")
        #expect(page.entries[1].avatarUrl == nil)
        #expect(page.me?.rank == 12)
        #expect(page.me?.flagged == false)
        #expect(page.entries.map(\.id) == ["1#octocat", "2#hubot"])
    }

    @Test("decodes a page with me null and the other contract responses")
    func decodesOtherResponses() throws {
        let page = try JSONDecoder().decode(LeaderboardPage.self, from: Data("""
        { "board": "lifetime", "updatedAt": "x", "totalUsers": 0, "entries": [], "me": null }
        """.utf8))
        #expect(page.me == nil && page.entries.isEmpty)

        let weekPage = try JSONDecoder().decode(LeaderboardPage.self, from: Data("""
        { "board": "week", "week": "2026-W36", "updatedAt": "2026-09-03T04:00:00Z", "totalUsers": 2,
          "entries": [ { "rank": 1, "login": "hubot", "avatarUrl": null, "usd": 400, "tokens": 8000000, "calls": 300, "topProvider": "claude" } ],
          "me": { "rank": 2, "usd": 150, "tokens": 5000000, "calls": 120, "flagged": false } }
        """.utf8))
        #expect(weekPage.board == "week")
        #expect(weekPage.week == "2026-W36")
        #expect(weekPage.month == nil)
        #expect(weekPage.metric == nil, "pre-metric servers send no metric")
        #expect(weekPage.entries.first?.login == "hubot")
        #expect(weekPage.me?.rank == 2)

        let metricPage = try JSONDecoder().decode(LeaderboardPage.self, from: Data("""
        { "board": "month", "metric": "streak", "month": "2026-09", "updatedAt": "x", "totalUsers": 3,
          "entries": [ { "rank": 1, "login": "hubot", "avatarUrl": null, "usd": 500, "tokens": 20000000,
                         "outputTokens": 9000000, "streakDays": 7, "calls": 900, "topProvider": "claude", "value": 7 } ],
          "me": { "rank": 3, "usd": 900, "tokens": 20000000, "outputTokens": 1000000, "streakDays": 3, "calls": 900, "value": 3, "flagged": false } }
        """.utf8))
        #expect(metricPage.metric == "streak")
        let top = try #require(metricPage.entries.first)
        #expect(top.value == 7 && top.outputTokens == 9_000_000 && top.streakDays == 7)
        #expect(top.metricValue(.streak) == 7 && top.metricValue(.output) == 9_000_000 && top.metricValue(.usd) == 500)
        let me = try #require(metricPage.me)
        #expect(me.value == 3 && me.metricValue(.output) == 1_000_000 && me.streakDays == 3)

        let config = try JSONDecoder().decode(LeaderboardConfig.self, from: Data("""
        { "githubClientId": "Iv1.x", "uploadIntervalMinutes": 10, "minAppVersion": "0.9.23", "board": { "week": "2026-W36", "month": "2026-09" } }
        """.utf8))
        #expect(config.githubClientId == "Iv1.x")
        #expect(config.effectiveUploadInterval == 30 * 60, "interval floor is 30 minutes")
        #expect(config.board?.month == "2026-09")
        #expect(config.board?.week == "2026-W36")

        let legacyConfig = try JSONDecoder().decode(LeaderboardConfig.self, from: Data("""
        { "githubClientId": "Iv1.x", "board": { "month": "2026-09" } }
        """.utf8))
        #expect(legacyConfig.board?.week == nil, "older servers send no week")

        let session = try JSONDecoder().decode(LeaderboardSessionResponse.self, from: Data("""
        { "sessionToken": "abc", "user": { "id": 123, "login": "octocat", "avatarUrl": "https://a" } }
        """.utf8))
        #expect(session.user.id == 123 && session.user.login == "octocat")

        let result = try JSONDecoder().decode(LeaderboardReportResponse.self, from: Data("""
        { "ok": true, "flagged": false, "rank": { "month": 12, "lifetime": 8 } }
        """.utf8))
        #expect(result.ok && result.flagged == false)
        #expect(result.rank?.month == 12 && result.rank?.lifetime == 8)
        #expect(result.rank?.week == nil, "rank.week absent or null when no week was reported")

        let withWeek = try JSONDecoder().decode(LeaderboardReportResponse.self, from: Data("""
        { "ok": true, "flagged": false, "rank": { "week": 3, "month": 12, "lifetime": 8 } }
        """.utf8))
        #expect(withWeek.rank?.week == 3)
        let nullWeek = try JSONDecoder().decode(LeaderboardReportResponse.self, from: Data("""
        { "ok": true, "flagged": false, "rank": { "week": null, "month": 12, "lifetime": 8 } }
        """.utf8))
        #expect(nullWeek.rank?.week == nil && nullWeek.rank?.month == 12)

        // Legacy flat ranks are the spend ranks; the other metrics stay unknown.
        let legacy = LeaderboardService.MyRank(try #require(withWeek.rank))
        #expect(legacy.rank(.usd, .week) == 3 && legacy.rank(.usd, .month) == 12 && legacy.rank(.usd, .lifetime) == 8)
        #expect(legacy.rank(.output, .month) == nil && legacy.rank(.streak, .lifetime) == nil)

        let perMetric = try JSONDecoder().decode(LeaderboardReportResponse.self, from: Data("""
        { "ok": true, "flagged": false, "rank": {
            "week": 3, "month": 12, "lifetime": 8,
            "usd": { "week": 3, "month": 12, "lifetime": 8 },
            "output": { "week": 1, "month": 2, "lifetime": 4 },
            "streak": { "week": null, "month": 5, "lifetime": 5 } } }
        """.utf8))
        var mine = LeaderboardService.MyRank(try #require(perMetric.rank))
        #expect(mine.rank(.usd, .month) == 12)
        #expect(mine.rank(.output, .week) == 1 && mine.rank(.output, .lifetime) == 4)
        #expect(mine.rank(.streak, .week) == nil && mine.rank(.streak, .month) == 5)
        mine[.streak][.week] = 9
        #expect(mine.rank(.streak, .week) == 9 && mine[.streak].month == 5)
    }

    // MARK: HTTP status mapping

    @Test("maps contract error envelopes onto typed errors")
    func mapsStatusCodes() {
        func response(_ status: Int, headers: [String: String] = [:]) -> HTTPURLResponse {
            HTTPURLResponse(url: URL(string: "https://example.test/v1/report")!, statusCode: status,
                            httpVersion: nil, headerFields: headers)!
        }
        #expect(throws: Never.self) {
            try LeaderboardService.checkStatus(response(204), data: Data())
        }
        #expect(throws: LeaderboardError.unauthorized) {
            try LeaderboardService.checkStatus(response(401), data: Data(#"{"error":"unauthorized"}"#.utf8))
        }
        #expect(throws: LeaderboardError.implausible("monthUSD exceeds lifetimeUSD")) {
            try LeaderboardService.checkStatus(
                response(422), data: Data(#"{"error":"implausible","message":"monthUSD exceeds lifetimeUSD"}"#.utf8))
        }
        #expect(throws: LeaderboardError.rateLimited(retryAfterSeconds: 420)) {
            try LeaderboardService.checkStatus(
                response(429), data: Data(#"{"error":"rate_limited","retryAfterSeconds":420}"#.utf8))
        }
        #expect(throws: LeaderboardError.rateLimited(retryAfterSeconds: 60)) {
            try LeaderboardService.checkStatus(response(429, headers: ["Retry-After": "60"]), data: Data())
        }
        #expect(throws: LeaderboardError.http(500, code: "boom", message: "D1 down")) {
            try LeaderboardService.checkStatus(response(500), data: Data(#"{"error":"boom","message":"D1 down"}"#.utf8))
        }
    }

    // MARK: Version gate

    @Test("version gate compares numeric cores and never blocks dev builds")
    func versionGate() {
        #expect(LeaderboardVersionGate.satisfies("0.9.23-zh4", minimum: "0.9.23"))
        #expect(LeaderboardVersionGate.satisfies("0.10.0", minimum: "0.9.23"))
        #expect(LeaderboardVersionGate.satisfies("v1.0", minimum: "0.9.23"))
        #expect(!LeaderboardVersionGate.satisfies("0.9.22", minimum: "0.9.23"))
        #expect(!LeaderboardVersionGate.satisfies("0.9", minimum: "0.9.1"))
        #expect(LeaderboardVersionGate.satisfies("dev", minimum: "0.9.23"))
        #expect(LeaderboardVersionGate.satisfies("", minimum: "0.9.23"))
        #expect(LeaderboardVersionGate.satisfies("0.1.0", minimum: ""))
    }
}
