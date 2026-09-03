import SwiftUI

/// Popover "Leaderboard" insight: top 20 for week / month / lifetime, ranked
/// by output tokens, spend or streak, with the user's own row pinned at the
/// bottom, or a join hint when they are not taking part.
struct LeaderboardSection: View {
    @Environment(AppStore.self) private var store
    @Environment(LeaderboardService.self) private var leaderboard
    @State private var board: LeaderboardBoard = .month
    /// Ranking metric, remembered across popover openings.
    @AppStorage(LeaderboardMetric.defaultsKey) private var metricRaw: String = LeaderboardMetric.default.rawValue
    /// Set when the user starts sign-in from the popover card, so finishing
    /// sign-in also turns sharing on and uploads right away (one click to join).
    @State private var joinRequested = false

    private var metric: LeaderboardMetric {
        LeaderboardMetric(rawValue: metricRaw) ?? .default
    }

    private var metricBinding: Binding<LeaderboardMetric> {
        Binding(get: { metric }, set: { metricRaw = $0.rawValue })
    }

    /// The (board, metric) pair the service caches pages under.
    private var key: LeaderboardService.BoardKey {
        LeaderboardService.BoardKey(board: board, metric: metric)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Picker("", selection: $board) {
                    ForEach(LeaderboardBoard.allCases) { board in
                        Text(board.displayName).tag(board)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .controlSize(.small)
                .frame(maxWidth: 200)

                Spacer()

                if let page = leaderboard.boards[key], let total = page.totalUsers {
                    Text(L("\(total) players"))
                        .font(.system(size: 10.5))
                        .foregroundStyle(.tertiary)
                        .monospacedDigit()
                }

                Button {
                    Task { await leaderboard.loadBoard(board, metric: metric, force: true) }
                } label: {
                    if leaderboard.loadingBoards.contains(key) {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 10, weight: .semibold))
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .frame(width: 16, height: 16)
                .help("Refresh leaderboard")
                .disabled(leaderboard.loadingBoards.contains(key))
            }

            Picker("", selection: metricBinding) {
                ForEach(LeaderboardMetric.allCases) { metric in
                    Text(metric.displayName).tag(metric)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .controlSize(.small)
            .frame(maxWidth: 200)

            if !leaderboard.isParticipating {
                joinCard
            }

            content

            if leaderboard.isParticipating {
                Divider().opacity(0.5)
                footer
            }
        }
        .task(id: key) { await leaderboard.loadBoard(board, metric: metric) }
        .onChange(of: leaderboard.isSignedIn) { _, signedIn in
            guard signedIn, joinRequested else { return }
            joinRequested = false
            leaderboard.isEnabled = true
            Task {
                _ = await leaderboard.upload()
                await leaderboard.loadBoard(board, metric: metric, force: true)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let page = leaderboard.boards[key] {
            if page.entries.isEmpty {
                placeholder(L("Nobody on the board yet. Be the first."))
            } else {
                VStack(spacing: 0) {
                    ForEach(page.entries.prefix(LeaderboardService.boardLimit)) { entry in
                        LeaderboardRow(
                            rank: entry.rank,
                            login: entry.login,
                            avatarUrl: entry.avatarUrl,
                            value: metric.format(entry.metricValue(metric) ?? entry.value ?? 0),
                            isMe: entry.login == leaderboard.user?.login
                        )
                    }
                }
            }
            if let error = leaderboard.boardErrors[key] {
                Text(error)
                    .font(.system(size: 10.5))
                    .foregroundStyle(.orange)
                    .lineLimit(2)
            }
        } else if let error = leaderboard.boardErrors[key] {
            VStack(alignment: .leading, spacing: 6) {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                Button("Retry") { Task { await leaderboard.loadBoard(board, metric: metric, force: true) } }
                    .controlSize(.small)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 8)
        } else {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Loading leaderboard…")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 16)
        }
    }

    private func placeholder(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 16)
    }

    @ViewBuilder
    private var footer: some View {
        if leaderboard.isParticipating, let user = leaderboard.user {
            let me = leaderboard.boards[key]?.me
            let rank = me?.rank ?? fallbackRank(for: board)
            HStack(spacing: 8) {
                Text(rank.map { "#\($0)" } ?? "—")
                    .font(.system(size: 11, weight: .semibold))
                    .monospacedDigit()
                    .frame(width: 30, alignment: .leading)
                LeaderboardAvatar(urlString: user.avatarUrl, size: 18)
                Text(L("You (\(user.login))"))
                    .font(.system(size: 11.5, weight: .medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                if let me, let value = me.metricValue(metric) ?? me.value {
                    Text(metric.format(value))
                        .font(.system(size: 11.5, weight: .medium))
                        .monospacedDigit()
                } else if leaderboard.lastUploadAt == nil {
                    Text("Not ranked yet")
                        .font(.system(size: 10.5))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.vertical, 2)
        }
    }

    /// Rank from the last report response, for the selected metric, when the
    /// page has not loaded a `me` row yet.
    private func fallbackRank(for board: LeaderboardBoard) -> Int? {
        leaderboard.myRank.rank(metric, board)
    }

    /// Shown at the top of the tab until the user takes part: sign-in runs
    /// right here (device code + Open GitHub) instead of sending them to
    /// Settings, and finishing it turns sharing on.
    @ViewBuilder
    private var joinCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch leaderboard.signInState {
            case .idle, .failed, .signedIn:
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "trophy.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(Theme.brandAccent)
                        .frame(width: 20)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Join the leaderboard")
                            .font(.system(size: 12, weight: .semibold))
                        if case let .failed(message) = leaderboard.signInState {
                            Text(L("Sign-in failed: \(message)"))
                                .font(.system(size: 10.5))
                                .foregroundStyle(.orange)
                                .lineLimit(2)
                        } else if leaderboard.isSignedIn, let user = leaderboard.user {
                            Text(L("Signed in as \(user.login). Sharing is off."))
                                .font(.system(size: 10.5))
                                .foregroundStyle(.secondary)
                        } else {
                            Text("Sign in with GitHub to appear here. Only your totals (spend, tokens, calls) are shared, never projects or prompts.")
                                .font(.system(size: 10.5))
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    Spacer(minLength: 8)
                    if leaderboard.isSignedIn {
                        Button("Join") {
                            leaderboard.isEnabled = true
                            Task {
                                _ = await leaderboard.upload()
                                await leaderboard.loadBoard(board, force: true)
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                    } else {
                        Button("Sign in with GitHub") {
                            joinRequested = true
                            leaderboard.signIn()
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                    }
                }
            case .requestingCode, .exchanging:
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text(leaderboard.signInState == .requestingCode ? L("Requesting a sign-in code…") : L("Signing in…"))
                        .font(.system(size: 11.5, weight: .medium))
                    Spacer()
                    Button("Cancel") {
                        joinRequested = false
                        leaderboard.cancelSignIn()
                    }
                    .controlSize(.small)
                }
            case let .waitingForUser(userCode, verificationURL, _):
                VStack(alignment: .leading, spacing: 8) {
                    Text("Enter this code on GitHub:")
                        .font(.system(size: 11.5, weight: .semibold))
                    HStack(spacing: 10) {
                        Text(userCode)
                            .font(.system(size: 24, weight: .bold, design: .monospaced))
                            .tracking(3)
                            .textSelection(.enabled)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(
                                RoundedRectangle(cornerRadius: 7, style: .continuous)
                                    .fill(Color.secondary.opacity(0.12)))
                        VStack(alignment: .leading, spacing: 5) {
                            Button("Open GitHub") { NSWorkspace.shared.open(verificationURL) }
                                .buttonStyle(.borderedProminent)
                                .controlSize(.small)
                            Button("Copy code") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(userCode, forType: .string)
                            }
                            .controlSize(.small)
                        }
                        Spacer()
                    }
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text("Waiting for you to authorize in the browser…")
                            .font(.system(size: 10.5))
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Cancel") {
                            joinRequested = false
                            leaderboard.cancelSignIn()
                        }
                        .controlSize(.small)
                    }
                }
            }
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Theme.brandAccent.opacity(0.08)))
    }

    /// Same deep-link path the Capacity Dock uses to land on a provider pane:
    /// the app delegate sets `store.settingsTab` and opens the window.
    private func openLeaderboardSettings() {
        store.settingsTab = "leaderboard"
        NotificationCenter.default.post(name: .capacityDockOpenProviderSettings, object: "leaderboard")
    }
}

private struct LeaderboardRow: View {
    let rank: Int
    let login: String
    let avatarUrl: String?
    /// The ranked number, already formatted for the selected metric.
    let value: String
    let isMe: Bool

    var body: some View {
        HStack(spacing: 8) {
            Text(verbatim: "\(rank)")
                .font(.system(size: 11, weight: rank <= 3 ? .bold : .regular))
                .monospacedDigit()
                .foregroundStyle(rank <= 3 ? AnyShapeStyle(Theme.brandAccent) : AnyShapeStyle(.secondary))
                .frame(width: 30, alignment: .leading)
            LeaderboardAvatar(urlString: avatarUrl, size: 18)
            Text(login)
                .font(.system(size: 11.5, weight: isMe ? .semibold : .regular))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 8)
            Text(value)
                .font(.system(size: 11.5, weight: .medium))
                .monospacedDigit()
        }
        .padding(.vertical, 3)
        .padding(.horizontal, 4)
        .background(
            RoundedRectangle(cornerRadius: 5)
                .fill(isMe ? Theme.brandAccent.opacity(0.10) : Color.clear))
    }
}
