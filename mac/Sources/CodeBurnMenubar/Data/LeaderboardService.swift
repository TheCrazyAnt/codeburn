import AppKit
import Foundation
import Observation

// CodeBurn Leaderboard client. The wire shapes below are the shared API
// contract (scratchpad/leaderboard/API.md); the Cloudflare backend is built
// against the same field names, so keep them identical.
//
// Privacy posture: only aggregate numbers leave the machine (USD, tokens,
// calls, an optional per-provider USD split, app version). Identity is a
// GitHub account via the device flow; the GitHub token is exchanged once for
// a server session and discarded. Tokens are never logged.

private let defaultServerURL = "https://codeburn-leaderboard.tangyishun9846.workers.dev"
private let serverDefaultsKey = "CodeBurnLeaderboardServer"
private let enabledDefaultsKey = "CodeBurnLeaderboardEnabled"
private let loginDefaultsKey = "CodeBurnLeaderboardLogin"
private let lastUploadDefaultsKey = "CodeBurnLeaderboardLastUploadAt"
private let keychainService = "CodeBurn Leaderboard"
private let requestTimeoutSeconds: TimeInterval = 30

// MARK: - Boards

/// Board selector shared by the popover segmented control and the API query.
enum LeaderboardBoard: String, CaseIterable, Identifiable, Sendable {
    /// Local calendar week, Monday 00:00 → now, keyed as ISO week `YYYY-Www`.
    case week
    case month
    case lifetime

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .week: L("This week")
        case .month: L("This month")
        case .lifetime: L("Lifetime")
        }
    }
}

/// What a board ranks by. Raw values are the API's stable `metric` ids.
enum LeaderboardMetric: String, CaseIterable, Identifiable, Sendable {
    /// Model output tokens. The default board.
    case output
    /// Spend in USD.
    case usd
    /// Consecutive active days (a per-user scalar, the same on every period board).
    case streak

    static let `default`: LeaderboardMetric = .output
    /// UserDefaults key the popover remembers its metric under.
    static let defaultsKey = "CodeBurnLeaderboardMetric"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .output: L("Output")
        case .usd: L("Spend")
        case .streak: L("Streak")
        }
    }

    /// Formats a ranked value the way the board shows it: tokens compact
    /// (1.2M / 340K), spend in the display currency, streak as days.
    @MainActor
    func format(_ value: Double) -> String {
        switch self {
        case .output: value.asCompactTokens()
        case .usd: value.asCompactCurrency()
        case .streak: L("\(Int(value.rounded())) days")
        }
    }
}

// MARK: - Wire types

struct LeaderboardConfig: Codable, Sendable, Equatable {
    struct Board: Codable, Sendable, Equatable {
        /// Server's current UTC ISO week (`YYYY-Www`); absent on older servers.
        let week: String?
        let month: String?
    }

    let githubClientId: String
    let uploadIntervalMinutes: Int?
    let minAppVersion: String?
    let board: Board?

    /// Contract: upload every `uploadIntervalMinutes`, never more often than
    /// every 30 minutes regardless of what the server asks for.
    var effectiveUploadInterval: TimeInterval {
        TimeInterval(max(uploadIntervalMinutes ?? 60, 30)) * 60
    }
}

struct LeaderboardUser: Codable, Sendable, Equatable {
    let id: Int
    let login: String
    let avatarUrl: String?
}

struct LeaderboardSessionResponse: Codable, Sendable, Equatable {
    let sessionToken: String
    let user: LeaderboardUser
}

/// Per-metric numbers a board row carries, plus the server's ranked `value`.
protocol LeaderboardMetricValues {
    var usd: Double? { get }
    var outputTokens: Int? { get }
    var streakDays: Int? { get }
    var value: Double? { get }
}

extension LeaderboardMetricValues {
    /// The row's number for `metric`, from the row's own fields (the server's
    /// `value` is only meaningful for the metric the page was fetched with).
    func metricValue(_ metric: LeaderboardMetric) -> Double? {
        switch metric {
        case .usd: usd
        case .output: outputTokens.map(Double.init)
        case .streak: streakDays.map(Double.init)
        }
    }
}

struct LeaderboardEntry: Codable, Sendable, Equatable, Identifiable, LeaderboardMetricValues {
    let rank: Int
    let login: String
    let avatarUrl: String?
    let usd: Double?
    let tokens: Int?
    let outputTokens: Int?
    let streakDays: Int?
    let calls: Int?
    let topProvider: String?
    /// The number this page is ranked by (per the page's `metric`).
    let value: Double?

    var id: String { "\(rank)#\(login)" }
}

struct LeaderboardMe: Codable, Sendable, Equatable, LeaderboardMetricValues {
    let rank: Int?
    let usd: Double?
    let tokens: Int?
    let outputTokens: Int?
    let streakDays: Int?
    let calls: Int?
    let value: Double?
    let flagged: Bool?
}

struct LeaderboardPage: Codable, Sendable, Equatable {
    let board: String
    /// Ranking metric id (`output` / `usd` / `streak`); absent on older servers (= spend).
    let metric: String?
    /// `week` is set on the week board, `month` on the others; never both.
    let week: String?
    let month: String?
    let updatedAt: String?
    let totalUsers: Int?
    let entries: [LeaderboardEntry]
    let me: LeaderboardMe?
}

struct LeaderboardReport: Codable, Sendable, Equatable {
    struct ProviderSplit: Codable, Sendable, Equatable {
        let id: String
        let monthUSD: Double
        let lifetimeUSD: Double
    }

    let month: String
    let monthUSD: Double
    let monthTokens: Int
    let monthCalls: Int
    /// Calendar-week slice (local Monday 00:00 → now), keyed as ISO week
    /// `YYYY-Www`. The four travel together: all set, or all omitted when
    /// the week could not be sourced. Not bounded by the month (a week can
    /// straddle two months), only by lifetime.
    let week: String?
    let weekUSD: Double?
    let weekTokens: Int?
    let weekCalls: Int?
    let weekOutputTokens: Int?
    let lifetimeUSD: Double
    let lifetimeTokens: Int
    let lifetimeCalls: Int
    /// Model output tokens per period (each ≤ the period's token total).
    let monthOutputTokens: Int
    let lifetimeOutputTokens: Int
    /// Consecutive active days ending today (or yesterday when today has no
    /// calls yet), and distinct active days in the daily series.
    let streakDays: Int
    let activeDays: Int
    /// Omitted (not `[]`) when the payload carries no provider split.
    let byProvider: [ProviderSplit]?
    let appVersion: String
    let reportedAt: String
}

struct LeaderboardReportResponse: Codable, Sendable, Equatable {
    struct PeriodRanks: Codable, Sendable, Equatable {
        /// Null when the report carried no week slice.
        let week: Int?
        let month: Int?
        let lifetime: Int?
    }

    /// The flat `week/month/lifetime` are the spend ranks (what pre-metric
    /// servers send); `usd/output/streak` carry one set per metric.
    struct Ranks: Codable, Sendable, Equatable {
        let week: Int?
        let month: Int?
        let lifetime: Int?
        let usd: PeriodRanks?
        let output: PeriodRanks?
        let streak: PeriodRanks?
    }

    let ok: Bool
    let flagged: Bool?
    let rank: Ranks?
}

struct LeaderboardAPIErrorBody: Codable, Sendable {
    let error: String?
    let message: String?
    let retryAfterSeconds: Int?
}

// MARK: - Errors

enum LeaderboardError: Error, LocalizedError, Equatable {
    case notSignedIn
    case notEnabled
    case usageDataUnavailable
    case appTooOld(minimum: String)
    case unauthorized
    case rateLimited(retryAfterSeconds: Int?)
    case implausible(String?)
    case http(Int, code: String?, message: String?)
    case decodeFailed
    case network(String)
    case keychain(String)
    case deviceFlow(String)

    var errorDescription: String? {
        switch self {
        case .notSignedIn:
            return L("Sign in with GitHub to join the leaderboard.")
        case .notEnabled:
            return L("Turn on leaderboard sharing to upload.")
        case .usageDataUnavailable:
            return L("Usage data is not loaded yet. Try again in a moment.")
        case let .appTooOld(minimum):
            return L("The leaderboard requires CodeBurn \(minimum) or newer. Update the app to keep uploading.")
        case .unauthorized:
            return L("Your leaderboard session expired. Sign in again.")
        case let .rateLimited(seconds):
            if let seconds, seconds > 0 {
                return L("The server accepted a report recently. Try again in \(max(1, seconds / 60)) min.")
            }
            return L("The server accepted a report recently. Try again later.")
        case let .implausible(message):
            return message.map { L("The server rejected the report: \($0)") }
                ?? L("The server rejected the report as implausible.")
        case let .http(status, _, message):
            if let message, !message.isEmpty { return L("Leaderboard server error (HTTP \(status)): \(message)") }
            return L("Leaderboard server error (HTTP \(status)).")
        case .decodeFailed:
            return L("The leaderboard server sent a malformed response.")
        case let .network(detail):
            return L("Network error: \(detail)")
        case let .keychain(detail):
            return detail
        case let .deviceFlow(detail):
            return detail
        }
    }
}

// MARK: - Report building (pure)

enum LeaderboardReportBuilder {
    enum BuildError: Error, LocalizedError, Equatable {
        case notFinite(String)
        case negative(String)

        var errorDescription: String? {
            switch self {
            case let .notFinite(field): return L("Report field \(field) is not a finite number.")
            case let .negative(field): return L("Report field \(field) is negative.")
            }
        }
    }

    /// Period totals as they leave the machine: raw USD before any FX
    /// conversion, tokens = input + output + cache read + cache write, and the
    /// provider split by stable provider id (lowercased).
    struct Totals: Equatable, Sendable {
        var usd: Double
        var tokens: Int
        var calls: Int
        var providers: [String: Double]
        /// Model output tokens, a subset of `tokens`.
        var outputTokens: Int

        init(usd: Double, tokens: Int, calls: Int, providers: [String: Double] = [:], outputTokens: Int = 0) {
            self.usd = usd
            self.tokens = tokens
            self.calls = calls
            self.providers = providers
            self.outputTokens = outputTokens
        }
    }

    static func totals(from payload: MenubarPayload) -> Totals {
        let current = payload.current
        return Totals(
            usd: current.cost,
            tokens: current.inputTokens + current.outputTokens + current.cacheReadTokens + current.cacheWriteTokens,
            calls: current.calls,
            providers: providerSplit(current),
            outputTokens: current.outputTokens
        )
    }

    /// Streak of consecutive active days (≥ 1 call) ending today, or ending
    /// yesterday when today has no calls yet, plus the distinct active days
    /// in the series. Derived from a per-day series, so a series shorter
    /// than the true streak caps it at the series length.
    struct Activity: Equatable, Sendable {
        var streakDays: Int
        var activeDays: Int

        static let none = Activity(streakDays: 0, activeDays: 0)
    }

    static func activity(from daily: [DailyHistoryEntry], now: Date, calendar: Calendar = .current) -> Activity {
        let activeDays = Set(daily.lazy.filter { $0.calls > 0 }.map(\.date))
        var cursor = now
        if !activeDays.contains(dayKey(cursor, calendar: calendar)),
           let yesterday = calendar.date(byAdding: .day, value: -1, to: cursor) {
            cursor = yesterday
        }
        var streak = 0
        while activeDays.contains(dayKey(cursor, calendar: calendar)) {
            streak += 1
            guard let previous = calendar.date(byAdding: .day, value: -1, to: cursor) else { break }
            cursor = previous
        }
        return Activity(streakDays: streak, activeDays: activeDays.count)
    }

    /// `providerDetails` (stable ids) wins when the CLI emits it; the legacy
    /// `providers` label map is the fallback. Zero-cost rows are dropped so an
    /// installed-but-idle provider never appears in the split.
    static func providerSplit(_ current: CurrentBlock) -> [String: Double] {
        var split: [String: Double] = [:]
        if !current.providerDetails.isEmpty {
            for detail in current.providerDetails where detail.cost.isFinite && detail.cost > 0 {
                split[normalizedProviderID(detail.id), default: 0] += detail.cost
            }
        } else {
            for (key, cost) in current.providers where cost.isFinite && cost > 0 {
                split[normalizedProviderID(key), default: 0] += cost
            }
        }
        return split
    }

    static func normalizedProviderID(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed.replacingOccurrences(of: " ", with: "-")
    }

    /// Client's current calendar month in local time, `YYYY-MM`.
    static func monthKey(for date: Date, calendar: Calendar = .current) -> String {
        let components = calendar.dateComponents([.year, .month], from: date)
        return String(format: "%04d-%02d", components.year ?? 0, components.month ?? 0)
    }

    /// `calendar` with ISO 8601 week rules: weeks start on Monday and week 1
    /// is the one holding January 4. The time zone stays the caller's, so the
    /// week boundary is the local Monday, matching what the user sees.
    static func isoWeekCalendar(_ calendar: Calendar) -> Calendar {
        var iso = calendar
        iso.firstWeekday = 2
        iso.minimumDaysInFirstWeek = 4
        return iso
    }

    /// Client's current ISO calendar week in local time, `YYYY-Www`. The
    /// server keys the board by UTC ISO week and tolerates ±1 week, which
    /// covers the hours around Monday 00:00 where local and UTC differ.
    static func weekKey(for date: Date, calendar: Calendar = .current) -> String {
        let components = isoWeekCalendar(calendar).dateComponents([.yearForWeekOfYear, .weekOfYear], from: date)
        return String(format: "%04d-W%02d", components.yearForWeekOfYear ?? 0, components.weekOfYear ?? 0)
    }

    /// Local Monday 00:00 of the week containing `date`.
    static func weekStart(for date: Date, calendar: Calendar = .current) -> Date {
        isoWeekCalendar(calendar).dateInterval(of: .weekOfYear, for: date)?.start ?? date
    }

    /// Week totals for the leaderboard: the 30-day payload's per-day series
    /// (`history.daily`) summed from local Monday through today inclusive.
    /// Each day carries cost, calls and all four token counts, so the sum has
    /// the same shape as a period's `current` block. The CLI keys days as
    /// `yyyy-MM-dd` in the machine's local time, the same clock `calendar`
    /// runs on, so a plain string range picks the right days. The daily
    /// series has no provider split, so `providers` stays empty and the
    /// report's `byProvider` keeps coming from the month and lifetime slices.
    static func weekTotals(from thirtyDayPayload: MenubarPayload, now: Date, calendar: Calendar = .current) -> Totals {
        let first = dayKey(weekStart(for: now, calendar: calendar), calendar: calendar)
        let last = dayKey(now, calendar: calendar)
        var totals = Totals(usd: 0, tokens: 0, calls: 0)
        for day in thirtyDayPayload.history.daily where day.date >= first && day.date <= last {
            totals.usd += day.cost
            totals.tokens += day.inputTokens + day.outputTokens + day.cacheReadTokens + day.cacheWriteTokens
            totals.outputTokens += day.outputTokens
            totals.calls += day.calls
        }
        return totals
    }

    /// `yyyy-MM-dd` in `calendar`'s time zone, the CLI's day-key format.
    static func dayKey(_ date: Date, calendar: Calendar = .current) -> String {
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", components.year ?? 0, components.month ?? 0, components.day ?? 0)
    }

    /// `week` and `weekKey` are optional together: the week slice ships only
    /// when both are known, otherwise the report is a month + lifetime one.
    static func build(
        month: Totals,
        lifetime: Totals,
        monthKey: String,
        week: Totals? = nil,
        weekKey: String? = nil,
        activity: Activity = .none,
        appVersion: String,
        reportedAt: Date
    ) throws -> LeaderboardReport {
        try validate(month.usd, "monthUSD")
        try validate(lifetime.usd, "lifetimeUSD")
        try validate(Double(month.tokens), "monthTokens")
        try validate(Double(lifetime.tokens), "lifetimeTokens")
        try validate(Double(month.calls), "monthCalls")
        try validate(Double(lifetime.calls), "lifetimeCalls")
        try validate(Double(month.outputTokens), "monthOutputTokens")
        try validate(Double(lifetime.outputTokens), "lifetimeOutputTokens")
        try validate(Double(activity.streakDays), "streakDays")
        try validate(Double(activity.activeDays), "activeDays")

        var weekSlice: (key: String, totals: Totals)?
        if let week, let weekKey {
            try validate(week.usd, "weekUSD")
            try validate(Double(week.tokens), "weekTokens")
            try validate(Double(week.calls), "weekCalls")
            try validate(Double(week.outputTokens), "weekOutputTokens")
            weekSlice = (weekKey, week)
        }

        // Month, week and lifetime are separate CLI fetches; a call that
        // landed between them can make a slice edge past lifetime. Lifetime
        // is by definition the largest, so lift it rather than ship a report
        // the server would reject as implausible.
        let lifetimeUSD = max(lifetime.usd, month.usd, weekSlice?.totals.usd ?? 0)
        let lifetimeTokens = max(lifetime.tokens, month.tokens, weekSlice?.totals.tokens ?? 0)
        let lifetimeCalls = max(lifetime.calls, month.calls, weekSlice?.totals.calls ?? 0)
        let lifetimeOutputTokens = max(lifetime.outputTokens, month.outputTokens, weekSlice?.totals.outputTokens ?? 0)
        // A streak is a run of active days, so it can never exceed them.
        let activeDays = max(activity.activeDays, activity.streakDays)

        let ids = Set(month.providers.keys).union(lifetime.providers.keys)
        let byProvider: [LeaderboardReport.ProviderSplit]? = ids.isEmpty ? nil : ids
            .map { id in
                let monthUSD = month.providers[id] ?? 0
                return LeaderboardReport.ProviderSplit(
                    id: id,
                    monthUSD: monthUSD,
                    lifetimeUSD: max(lifetime.providers[id] ?? 0, monthUSD)
                )
            }
            .sorted { lhs, rhs in
                lhs.lifetimeUSD != rhs.lifetimeUSD ? lhs.lifetimeUSD > rhs.lifetimeUSD : lhs.id < rhs.id
            }

        return LeaderboardReport(
            month: monthKey,
            monthUSD: month.usd,
            monthTokens: month.tokens,
            monthCalls: month.calls,
            week: weekSlice?.key,
            weekUSD: weekSlice?.totals.usd,
            weekTokens: weekSlice?.totals.tokens,
            weekCalls: weekSlice?.totals.calls,
            weekOutputTokens: weekSlice?.totals.outputTokens,
            lifetimeUSD: lifetimeUSD,
            lifetimeTokens: lifetimeTokens,
            lifetimeCalls: lifetimeCalls,
            monthOutputTokens: month.outputTokens,
            lifetimeOutputTokens: lifetimeOutputTokens,
            streakDays: activity.streakDays,
            activeDays: activeDays,
            byProvider: byProvider,
            appVersion: appVersion,
            reportedAt: iso8601(reportedAt)
        )
    }

    private static func validate(_ value: Double, _ field: String) throws {
        guard value.isFinite else { throw BuildError.notFinite(field) }
        guard value >= 0 else { throw BuildError.negative(field) }
    }

    static func iso8601(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        f.timeZone = TimeZone(secondsFromGMT: 0)
        return f.string(from: date)
    }
}

// MARK: - Version gate (pure)

enum LeaderboardVersionGate {
    /// True when `version` satisfies `minimum`. Compares dotted numeric cores
    /// only (`0.9.23-zh4` → 0.9.23); non-numeric builds ("dev") are never
    /// blocked, so a local build can still talk to the server.
    static func satisfies(_ version: String, minimum: String) -> Bool {
        guard let required = numericCore(minimum) else { return true }
        guard let actual = numericCore(version) else { return true }
        let count = max(required.count, actual.count)
        for index in 0..<count {
            let lhs = index < actual.count ? actual[index] : 0
            let rhs = index < required.count ? required[index] : 0
            if lhs != rhs { return lhs > rhs }
        }
        return true
    }

    static func numericCore(_ version: String) -> [Int]? {
        let normalized = AppVersion.normalize(version)
        let core = normalized.split(whereSeparator: { $0 == "-" || $0 == "+" }).first.map(String.init) ?? ""
        let parts = core.split(separator: ".").map { Int($0) }
        guard !parts.isEmpty, parts.allSatisfy({ $0 != nil }) else { return nil }
        return parts.map { $0! }
    }
}

// MARK: - GitHub device flow (pure request/response shaping)

enum GitHubDeviceFlow {
    static let deviceCodeURL = URL(string: "https://github.com/login/device/code")!
    static let accessTokenURL = URL(string: "https://github.com/login/oauth/access_token")!
    static let grantType = "urn:ietf:params:oauth:grant-type:device_code"

    struct DeviceCode: Equatable, Sendable {
        let deviceCode: String
        let userCode: String
        let verificationURL: URL
        let expiresIn: Int
        let interval: Int
    }

    enum PollOutcome: Equatable, Sendable {
        case accessToken(String)
        case pending
        case slowDown
        case expired
        case denied
        case failure(String)
    }

    static func codeRequest(clientId: String) -> URLRequest {
        formRequest(url: deviceCodeURL, fields: [("client_id", clientId), ("scope", "")])
    }

    static func pollRequest(clientId: String, deviceCode: String) -> URLRequest {
        formRequest(url: accessTokenURL, fields: [
            ("client_id", clientId),
            ("device_code", deviceCode),
            ("grant_type", grantType),
        ])
    }

    private static func formRequest(url: URL, fields: [(String, String)]) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = requestTimeoutSeconds
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("CodeBurnMenubar/\(AppVersion.normalizedBundleShortVersion)", forHTTPHeaderField: "User-Agent")
        request.httpBody = formBody(fields)
        return request
    }

    static func formBody(_ fields: [(String, String)]) -> Data {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return fields
            .map { key, value in
                "\(key.addingPercentEncoding(withAllowedCharacters: allowed) ?? key)=\(value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value)"
            }
            .joined(separator: "&")
            .data(using: .utf8) ?? Data()
    }

    static func parseDeviceCode(_ data: Data) throws -> DeviceCode {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw LeaderboardError.decodeFailed
        }
        if let error = root["error"] as? String {
            throw LeaderboardError.deviceFlow(deviceFlowMessage(code: error, description: root["error_description"] as? String))
        }
        guard let deviceCode = root["device_code"] as? String, !deviceCode.isEmpty,
              let userCode = root["user_code"] as? String, !userCode.isEmpty else {
            throw LeaderboardError.decodeFailed
        }
        let verification = (root["verification_uri"] as? String).flatMap(URL.init(string:))
            ?? URL(string: "https://github.com/login/device")!
        return DeviceCode(
            deviceCode: deviceCode,
            userCode: userCode,
            verificationURL: verification,
            expiresIn: (root["expires_in"] as? NSNumber)?.intValue ?? 900,
            interval: (root["interval"] as? NSNumber)?.intValue ?? 5
        )
    }

    static func parsePoll(_ data: Data) -> PollOutcome {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return .failure(L("GitHub sent a malformed response."))
        }
        if let token = root["access_token"] as? String, !token.isEmpty {
            return .accessToken(token)
        }
        switch root["error"] as? String {
        case "authorization_pending": return .pending
        case "slow_down": return .slowDown
        case "expired_token": return .expired
        case "access_denied": return .denied
        case let code?:
            return .failure(deviceFlowMessage(code: code, description: root["error_description"] as? String))
        case nil:
            return .failure(L("GitHub sent a malformed response."))
        }
    }

    private static func deviceFlowMessage(code: String, description: String?) -> String {
        if let description, !description.isEmpty { return description }
        return L("GitHub sign-in failed (\(code)).")
    }
}

// MARK: - Service

@MainActor
@Observable
final class LeaderboardService {
    /// Device-flow state machine. `signedIn` is the only state that carries a
    /// usable session; `failed` keeps the human message for the Settings pane.
    enum SignInState: Equatable {
        case idle
        case requestingCode
        case waitingForUser(userCode: String, verificationURL: URL, expiresAt: Date)
        case exchanging
        case signedIn(LeaderboardUser)
        case failed(String)
    }

    struct PeriodRanks: Equatable, Sendable {
        var week: Int?
        var month: Int?
        var lifetime: Int?

        subscript(_ board: LeaderboardBoard) -> Int? {
            get {
                switch board {
                case .week: week
                case .month: month
                case .lifetime: lifetime
                }
            }
            set {
                switch board {
                case .week: week = newValue
                case .month: month = newValue
                case .lifetime: lifetime = newValue
                }
            }
        }
    }

    /// The user's own rank per metric and board: seeded by the report
    /// response, refreshed by every board load that carries `me`.
    struct MyRank: Equatable, Sendable {
        private var byMetric: [LeaderboardMetric: PeriodRanks] = [:]

        init() {}

        /// Nested per-metric ranks win; the flat fields are the spend ranks
        /// an older server sends.
        init(_ ranks: LeaderboardReportResponse.Ranks) {
            func periods(_ wire: LeaderboardReportResponse.PeriodRanks) -> PeriodRanks {
                PeriodRanks(week: wire.week, month: wire.month, lifetime: wire.lifetime)
            }
            self[.usd] = ranks.usd.map(periods) ?? PeriodRanks(week: ranks.week, month: ranks.month, lifetime: ranks.lifetime)
            if let output = ranks.output { self[.output] = periods(output) }
            if let streak = ranks.streak { self[.streak] = periods(streak) }
        }

        subscript(_ metric: LeaderboardMetric) -> PeriodRanks {
            get { byMetric[metric] ?? PeriodRanks() }
            set { byMetric[metric] = newValue }
        }

        func rank(_ metric: LeaderboardMetric, _ board: LeaderboardBoard) -> Int? {
            self[metric][board]
        }
    }

    /// One cached page per (board, metric).
    struct BoardKey: Hashable, Sendable {
        let board: LeaderboardBoard
        let metric: LeaderboardMetric
    }

    /// Injectable seams so the pure parts stay testable without a network.
    /// Main-actor bound like the service itself (UserDefaults is not Sendable).
    @MainActor
    struct Deps {
        var fetch: @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)
        var keychain: any KeychainCredentialCaching
        var defaults: UserDefaults
        var now: @Sendable () -> Date
        var appVersion: @Sendable () -> String

        static let live = Deps(
            fetch: { request in
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse else {
                    throw LeaderboardError.network(L("No HTTP response."))
                }
                return (data, http)
            },
            keychain: LiveKeychainCredentialCache(),
            defaults: .standard,
            now: { Date() },
            appVersion: { AppVersion.normalizedBundleShortVersion }
        )
    }

    static let boardCacheTTL: TimeInterval = 60
    static let defaultUploadInterval: TimeInterval = 60 * 60
    /// Server accepts one report per user per 10 minutes; do not even try sooner.
    static let minimumUploadSpacing: TimeInterval = 10 * 60
    static let boardLimit = 20

    var signInState: SignInState = .idle
    var isEnabled: Bool {
        didSet {
            guard isEnabled != oldValue else { return }
            deps.defaults.set(isEnabled, forKey: enabledDefaultsKey)
            restartUploadLoop()
        }
    }
    private(set) var config: LeaderboardConfig?
    private(set) var configError: String?
    private(set) var lastUploadAt: Date?
    private(set) var lastUploadError: String?
    private(set) var lastReport: LeaderboardReport?
    private(set) var lastReportFlagged = false
    private(set) var myRank = MyRank()
    private(set) var isUploading = false
    private(set) var isDeletingData = false
    private(set) var boards: [BoardKey: LeaderboardPage] = [:]
    private(set) var boardErrors: [BoardKey: String] = [:]
    private(set) var loadingBoards: Set<BoardKey> = []

    @ObservationIgnored private let deps: Deps
    @ObservationIgnored private weak var store: AppStore?
    /// Session token lives only here and in the Keychain. Never logged.
    @ObservationIgnored private var session: LeaderboardSessionResponse?
    @ObservationIgnored private var signInTask: Task<Void, Never>?
    @ObservationIgnored private var uploadLoopTask: Task<Void, Never>?
    @ObservationIgnored private var boardFetchedAt: [BoardKey: Date] = [:]
    @ObservationIgnored private var usageDataLoaded = false

    init(store: AppStore, deps: Deps = .live) {
        self.store = store
        self.deps = deps
        self.isEnabled = deps.defaults.bool(forKey: enabledDefaultsKey)
        self.lastUploadAt = deps.defaults.object(forKey: lastUploadDefaultsKey) as? Date
    }

    // MARK: Derived state

    var user: LeaderboardUser? {
        if case let .signedIn(user) = signInState { return user }
        return nil
    }

    var isSignedIn: Bool { user != nil }

    var isSigningIn: Bool {
        switch signInState {
        case .requestingCode, .waitingForUser, .exchanging: return true
        case .idle, .signedIn, .failed: return false
        }
    }

    /// Both preconditions for uploads: opted in and holding a session.
    var isParticipating: Bool { isEnabled && isSignedIn }

    var serverURL: URL {
        let raw = deps.defaults.string(forKey: serverDefaultsKey)?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let raw, !raw.isEmpty, let url = URL(string: raw), url.scheme != nil { return url }
        return URL(string: defaultServerURL)!
    }

    // MARK: Lifecycle

    /// Called once at launch: restore the session from the Keychain and warm
    /// the config. Neither failure is fatal; the pane shows what it can.
    func start() {
        restoreSession()
        Task { [weak self] in
            await self?.refreshConfig()
        }
    }

    /// The upload loop waits for the first successful usage load so the very
    /// first report is never built from an empty cache.
    func noteUsageDataLoaded() {
        guard !usageDataLoaded else { return }
        usageDataLoaded = true
        restartUploadLoop()
    }

    // MARK: Config

    @discardableResult
    func refreshConfig() async -> LeaderboardConfig? {
        do {
            let (data, response) = try await send(path: "/v1/config", method: "GET", auth: false)
            try Self.checkStatus(response, data: data)
            let decoded = try Self.decode(LeaderboardConfig.self, from: data)
            config = decoded
            configError = nil
            return decoded
        } catch {
            configError = Self.message(for: error)
            return nil
        }
    }

    private func ensureConfig() async throws -> LeaderboardConfig {
        if let config { return config }
        if let fetched = await refreshConfig() { return fetched }
        throw LeaderboardError.network(configError ?? L("Could not reach the leaderboard server."))
    }

    // MARK: Sign in (GitHub device flow)

    func signIn() {
        guard !isSigningIn else { return }
        signInTask?.cancel()
        signInTask = Task { [weak self] in
            await self?.runDeviceFlow()
        }
    }

    func cancelSignIn() {
        signInTask?.cancel()
        signInTask = nil
        if isSigningIn { signInState = .idle }
    }

    func openVerificationURL() {
        if case let .waitingForUser(_, url, _) = signInState {
            NSWorkspace.shared.open(url)
        }
    }

    private func runDeviceFlow() async {
        signInState = .requestingCode
        do {
            let config = try await ensureConfig()
            guard !config.githubClientId.isEmpty else {
                throw LeaderboardError.deviceFlow(L("The leaderboard server has no GitHub app configured yet."))
            }
            let (codeData, codeResponse) = try await fetch(GitHubDeviceFlow.codeRequest(clientId: config.githubClientId))
            guard (200..<300).contains(codeResponse.statusCode) else {
                throw LeaderboardError.deviceFlow(L("GitHub refused the device code request (HTTP \(codeResponse.statusCode))."))
            }
            let code = try GitHubDeviceFlow.parseDeviceCode(codeData)
            let expiresAt = deps.now().addingTimeInterval(TimeInterval(code.expiresIn))
            signInState = .waitingForUser(userCode: code.userCode, verificationURL: code.verificationURL, expiresAt: expiresAt)
            NSWorkspace.shared.open(code.verificationURL)

            var interval = max(code.interval, 5)
            while true {
                try Task.checkCancellation()
                try await Task.sleep(for: .seconds(interval))
                try Task.checkCancellation()
                if deps.now() >= expiresAt {
                    throw LeaderboardError.deviceFlow(L("The code expired before it was entered. Try again."))
                }
                let (pollData, _) = try await fetch(
                    GitHubDeviceFlow.pollRequest(clientId: config.githubClientId, deviceCode: code.deviceCode))
                switch GitHubDeviceFlow.parsePoll(pollData) {
                case let .accessToken(token):
                    signInState = .exchanging
                    try await exchange(githubAccessToken: token)
                    return
                case .pending:
                    continue
                case .slowDown:
                    interval += 5
                case .expired:
                    throw LeaderboardError.deviceFlow(L("The code expired before it was entered. Try again."))
                case .denied:
                    throw LeaderboardError.deviceFlow(L("GitHub reported that you declined the authorization."))
                case let .failure(message):
                    throw LeaderboardError.deviceFlow(message)
                }
            }
        } catch is CancellationError {
            signInState = .idle
        } catch {
            if Task.isCancelled {
                signInState = .idle
            } else {
                signInState = .failed(Self.message(for: error))
            }
        }
    }

    private func exchange(githubAccessToken: String) async throws {
        let body = try JSONEncoder().encode([
            "githubAccessToken": githubAccessToken,
            "appVersion": deps.appVersion(),
        ])
        let (data, response) = try await send(path: "/v1/session", method: "POST", body: body, auth: false)
        if response.statusCode == 401 {
            throw LeaderboardError.deviceFlow(L("GitHub did not accept the sign-in token. Try again."))
        }
        try Self.checkStatus(response, data: data)
        let decoded = try Self.decode(LeaderboardSessionResponse.self, from: data)
        session = decoded
        signInState = .signedIn(decoded.user)
        persistSession(decoded)
        invalidateBoards()
        restartUploadLoop()
    }

    // MARK: Session persistence

    private func restoreSession() {
        guard let login = deps.defaults.string(forKey: loginDefaultsKey), !login.isEmpty else { return }
        do {
            guard let data = try deps.keychain.read(service: keychainService, account: login) else {
                deps.defaults.removeObject(forKey: loginDefaultsKey)
                return
            }
            let decoded = try JSONDecoder().decode(LeaderboardSessionResponse.self, from: data)
            session = decoded
            signInState = .signedIn(decoded.user)
        } catch let error as KeychainCredentialCacheError {
            // Locked keychain: keep the login so a later restore can succeed,
            // and tell the pane why there is no session right now.
            signInState = .failed(error.localizedDescription)
        } catch {
            deps.defaults.removeObject(forKey: loginDefaultsKey)
        }
    }

    private func persistSession(_ session: LeaderboardSessionResponse) {
        do {
            let data = try JSONEncoder().encode(session)
            try deps.keychain.upsert(service: keychainService, account: session.user.login, data: data)
            deps.defaults.set(session.user.login, forKey: loginDefaultsKey)
        } catch {
            NSLog("CodeBurn: leaderboard session could not be saved to the Keychain (%@)", String(describing: type(of: error)))
        }
    }

    /// Drops the session everywhere. `message` (when given) becomes the
    /// signed-out state's explanation, e.g. after a 401.
    private func clearSession(message: String? = nil) {
        if let login = session?.user.login ?? deps.defaults.string(forKey: loginDefaultsKey) {
            try? deps.keychain.delete(service: keychainService, account: login)
        }
        deps.defaults.removeObject(forKey: loginDefaultsKey)
        session = nil
        signInState = message.map(SignInState.failed) ?? .idle
        myRank = MyRank()
        invalidateBoards()
        restartUploadLoop()
    }

    // MARK: Sign out / delete

    func signOut() async {
        cancelSignIn()
        if session != nil {
            // Best effort: the local session is gone either way.
            _ = try? await send(path: "/v1/logout", method: "POST", auth: true, handleUnauthorized: false)
        }
        clearSession()
    }

    /// Privacy requirement: removes the user, sessions, weekly and monthly
    /// rows, and the report log server-side, then forgets everything locally
    /// and opts out.
    func deleteMyData() async throws {
        guard session != nil else { throw LeaderboardError.notSignedIn }
        isDeletingData = true
        defer { isDeletingData = false }
        do {
            let (data, response) = try await send(path: "/v1/me", method: "DELETE", auth: true)
            try Self.checkStatus(response, data: data)
        } catch LeaderboardError.unauthorized {
            // Session already dead: nothing server-side to keep anyway.
        }
        lastReport = nil
        lastUploadAt = nil
        lastUploadError = nil
        lastReportFlagged = false
        deps.defaults.removeObject(forKey: lastUploadDefaultsKey)
        isEnabled = false
        clearSession()
    }

    // MARK: Upload

    private func restartUploadLoop() {
        uploadLoopTask?.cancel()
        uploadLoopTask = nil
        guard usageDataLoaded, isParticipating else { return }
        uploadLoopTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.uploadIfDue()
                let interval = self.config?.effectiveUploadInterval ?? Self.defaultUploadInterval
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }

    private func uploadIfDue() async {
        if let lastUploadAt, deps.now().timeIntervalSince(lastUploadAt) < Self.minimumUploadSpacing { return }
        _ = await upload(force: false)
    }

    /// "Upload now" and the scheduler share this. Returns true on an accepted
    /// report; failures are surfaced through `lastUploadError`, never thrown
    /// at the UI.
    @discardableResult
    func upload(force: Bool = true) async -> Bool {
        guard !isUploading else { return false }
        isUploading = true
        defer { isUploading = false }
        do {
            guard session != nil else { throw LeaderboardError.notSignedIn }
            guard isEnabled else { throw LeaderboardError.notEnabled }
            let config = try await ensureConfig()
            if let minimum = config.minAppVersion, !LeaderboardVersionGate.satisfies(deps.appVersion(), minimum: minimum) {
                throw LeaderboardError.appTooOld(minimum: minimum)
            }
            let report = try await buildReport()
            let body = try JSONEncoder().encode(report)
            let (data, response) = try await send(path: "/v1/report", method: "POST", body: body, auth: true)
            try Self.checkStatus(response, data: data)
            let result = try Self.decode(LeaderboardReportResponse.self, from: data)
            lastReport = report
            lastReportFlagged = result.flagged ?? false
            if let rank = result.rank {
                myRank = MyRank(rank)
            }
            let now = deps.now()
            lastUploadAt = now
            deps.defaults.set(now, forKey: lastUploadDefaultsKey)
            lastUploadError = nil
            invalidateBoards()
            return true
        } catch {
            lastUploadError = Self.message(for: error)
            return false
        }
    }

    /// Refreshes the month, 30-day and lifetime all-provider payloads through
    /// the store's normal quiet path, then reads them back from its cache.
    /// Month and lifetime are required; the week is summed from the 30-day
    /// payload's per-day series (local Monday → today) and simply left out of
    /// the report when that payload is unavailable, so a missing week never
    /// blocks the upload.
    private func buildReport() async throws -> LeaderboardReport {
        guard let store else { throw LeaderboardError.usageDataUnavailable }
        async let monthLoaded = store.refreshQuietly(period: .month, qualityOfService: .utility)
        async let thirtyDaysLoaded = store.refreshQuietly(period: .thirtyDays, qualityOfService: .utility)
        async let lifetimeLoaded = store.refreshQuietly(period: .lifetime, qualityOfService: .utility)
        _ = await (monthLoaded, thirtyDaysLoaded, lifetimeLoaded)
        guard let monthPayload = store.allProviderPayload(for: .month),
              let lifetimePayload = store.allProviderPayload(for: .lifetime) else {
            throw LeaderboardError.usageDataUnavailable
        }
        let now = deps.now()
        let thirtyDayPayload = store.allProviderPayload(for: .thirtyDays)
        let week = thirtyDayPayload.map { LeaderboardReportBuilder.weekTotals(from: $0, now: now) }
        // The streak wants the longest per-day series on hand: lifetime
        // (CLI caps it at 365 days) normally, the 30-day one as a fallback.
        let lifetimeDaily = lifetimePayload.history.daily
        let thirtyDaily = thirtyDayPayload?.history.daily ?? []
        let activity = LeaderboardReportBuilder.activity(
            from: lifetimeDaily.count >= thirtyDaily.count ? lifetimeDaily : thirtyDaily, now: now)
        return try LeaderboardReportBuilder.build(
            month: LeaderboardReportBuilder.totals(from: monthPayload),
            lifetime: LeaderboardReportBuilder.totals(from: lifetimePayload),
            monthKey: LeaderboardReportBuilder.monthKey(for: now),
            week: week,
            weekKey: week == nil ? nil : LeaderboardReportBuilder.weekKey(for: now),
            activity: activity,
            appVersion: deps.appVersion(),
            reportedAt: now
        )
    }

    // MARK: Boards

    /// The cached page for a board and metric, if any.
    func page(_ board: LeaderboardBoard, metric: LeaderboardMetric = .default) -> LeaderboardPage? {
        boards[BoardKey(board: board, metric: metric)]
    }

    func loadBoard(_ board: LeaderboardBoard, metric: LeaderboardMetric = .default, force: Bool = false) async {
        let key = BoardKey(board: board, metric: metric)
        if !force, let fetchedAt = boardFetchedAt[key], boards[key] != nil,
           deps.now().timeIntervalSince(fetchedAt) < Self.boardCacheTTL {
            return
        }
        guard !loadingBoards.contains(key) else { return }
        loadingBoards.insert(key)
        defer { loadingBoards.remove(key) }
        do {
            let page = try await fetchBoard(board, metric: metric, authenticated: session != nil)
            boards[key] = page
            boardErrors[key] = nil
            boardFetchedAt[key] = deps.now()
            if let me = page.me {
                myRank[metric][board] = me.rank
            }
        } catch LeaderboardError.unauthorized {
            // The session was cleared; the public board still renders.
            if let page = try? await fetchBoard(board, metric: metric, authenticated: false) {
                boards[key] = page
                boardErrors[key] = nil
                boardFetchedAt[key] = deps.now()
            } else {
                boardErrors[key] = LeaderboardError.unauthorized.localizedDescription
            }
        } catch {
            boardErrors[key] = Self.message(for: error)
        }
    }

    private func fetchBoard(_ board: LeaderboardBoard, metric: LeaderboardMetric, authenticated: Bool) async throws -> LeaderboardPage {
        var query = "board=\(board.rawValue)&metric=\(metric.rawValue)&limit=\(Self.boardLimit)"
        switch board {
        case .week: query += "&week=\(LeaderboardReportBuilder.weekKey(for: deps.now()))"
        case .month: query += "&month=\(LeaderboardReportBuilder.monthKey(for: deps.now()))"
        case .lifetime: break
        }
        let (data, response) = try await send(path: "/v1/leaderboard?\(query)", method: "GET", auth: authenticated)
        try Self.checkStatus(response, data: data)
        return try Self.decode(LeaderboardPage.self, from: data)
    }

    private func invalidateBoards() {
        boardFetchedAt.removeAll()
    }

    // MARK: HTTP plumbing

    private func fetch(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            return try await deps.fetch(request)
        } catch let error as LeaderboardError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw LeaderboardError.network(error.localizedDescription)
        }
    }

    private func send(
        path: String,
        method: String,
        body: Data? = nil,
        auth: Bool,
        handleUnauthorized: Bool = true
    ) async throws -> (Data, HTTPURLResponse) {
        guard let url = URL(string: path, relativeTo: serverURL)?.absoluteURL else {
            throw LeaderboardError.network(L("Invalid leaderboard server URL."))
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = requestTimeoutSeconds
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("CodeBurnMenubar/\(deps.appVersion())", forHTTPHeaderField: "User-Agent")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if auth {
            guard let token = session?.sessionToken else { throw LeaderboardError.notSignedIn }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await fetch(request)
        if auth, handleUnauthorized, response.statusCode == 401 {
            clearSession(message: LeaderboardError.unauthorized.localizedDescription)
            throw LeaderboardError.unauthorized
        }
        return (data, response)
    }

    /// Maps the contract's error envelope onto typed errors. 2xx passes.
    nonisolated static func checkStatus(_ response: HTTPURLResponse, data: Data) throws {
        if (200..<300).contains(response.statusCode) { return }
        let envelope = try? JSONDecoder().decode(LeaderboardAPIErrorBody.self, from: data)
        switch response.statusCode {
        case 401:
            throw LeaderboardError.unauthorized
        case 422:
            throw LeaderboardError.implausible(envelope?.message)
        case 429:
            let header = response.value(forHTTPHeaderField: "Retry-After").flatMap { Int($0.trimmingCharacters(in: .whitespaces)) }
            throw LeaderboardError.rateLimited(retryAfterSeconds: envelope?.retryAfterSeconds ?? header)
        default:
            throw LeaderboardError.http(response.statusCode, code: envelope?.error, message: envelope?.message)
        }
    }

    nonisolated static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            // Never log the body; a session response would carry the token.
            throw LeaderboardError.decodeFailed
        }
    }

    nonisolated static func message(for error: Error) -> String {
        if let localized = error as? LocalizedError, let description = localized.errorDescription {
            return description
        }
        return error.localizedDescription
    }
}
