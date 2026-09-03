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
        providers: String = "{}"
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
          "history": { "daily": [] }
        }
        """.data(using: .utf8)!
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
        #expect(keys == ["appVersion", "lifetimeCalls", "lifetimeTokens", "lifetimeUSD",
                         "month", "monthCalls", "monthTokens", "monthUSD", "reportedAt"])
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

        let config = try JSONDecoder().decode(LeaderboardConfig.self, from: Data("""
        { "githubClientId": "Iv1.x", "uploadIntervalMinutes": 10, "minAppVersion": "0.9.23", "board": { "month": "2026-09" } }
        """.utf8))
        #expect(config.githubClientId == "Iv1.x")
        #expect(config.effectiveUploadInterval == 30 * 60, "interval floor is 30 minutes")
        #expect(config.board?.month == "2026-09")

        let session = try JSONDecoder().decode(LeaderboardSessionResponse.self, from: Data("""
        { "sessionToken": "abc", "user": { "id": 123, "login": "octocat", "avatarUrl": "https://a" } }
        """.utf8))
        #expect(session.user.id == 123 && session.user.login == "octocat")

        let result = try JSONDecoder().decode(LeaderboardReportResponse.self, from: Data("""
        { "ok": true, "flagged": false, "rank": { "month": 12, "lifetime": 8 } }
        """.utf8))
        #expect(result.ok && result.flagged == false)
        #expect(result.rank?.month == 12 && result.rank?.lifetime == 8)
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
