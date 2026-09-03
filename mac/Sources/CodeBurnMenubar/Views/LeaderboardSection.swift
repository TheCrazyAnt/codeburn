import SwiftUI

/// Popover "Leaderboard" insight: top 20 for month / lifetime with the user's
/// own row pinned at the bottom, or a join hint when they are not taking part.
struct LeaderboardSection: View {
    @Environment(AppStore.self) private var store
    @Environment(LeaderboardService.self) private var leaderboard
    @State private var board: LeaderboardBoard = .month

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

                if let page = leaderboard.boards[board], let total = page.totalUsers {
                    Text(L("\(total) players"))
                        .font(.system(size: 10.5))
                        .foregroundStyle(.tertiary)
                        .monospacedDigit()
                }

                Button {
                    Task { await leaderboard.loadBoard(board, force: true) }
                } label: {
                    if leaderboard.loadingBoards.contains(board) {
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
                .disabled(leaderboard.loadingBoards.contains(board))
            }

            content

            Divider().opacity(0.5)

            footer
        }
        .task(id: board) { await leaderboard.loadBoard(board) }
    }

    @ViewBuilder
    private var content: some View {
        if let page = leaderboard.boards[board] {
            if page.entries.isEmpty {
                placeholder(L("Nobody on the board yet. Be the first."))
            } else {
                VStack(spacing: 0) {
                    ForEach(page.entries.prefix(LeaderboardService.boardLimit)) { entry in
                        LeaderboardRow(
                            rank: entry.rank,
                            login: entry.login,
                            avatarUrl: entry.avatarUrl,
                            usd: entry.usd,
                            isMe: entry.login == leaderboard.user?.login
                        )
                    }
                }
            }
            if let error = leaderboard.boardErrors[board] {
                Text(error)
                    .font(.system(size: 10.5))
                    .foregroundStyle(.orange)
                    .lineLimit(2)
            }
        } else if let error = leaderboard.boardErrors[board] {
            VStack(alignment: .leading, spacing: 6) {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                Button("Retry") { Task { await leaderboard.loadBoard(board, force: true) } }
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
            let me = leaderboard.boards[board]?.me
            let rank = me?.rank ?? (board == .month ? leaderboard.myRank.month : leaderboard.myRank.lifetime)
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
                if let usd = me?.usd {
                    Text(usd.asCompactCurrency())
                        .font(.system(size: 11.5, weight: .medium))
                        .monospacedDigit()
                } else if leaderboard.lastUploadAt == nil {
                    Text("Not ranked yet")
                        .font(.system(size: 10.5))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.vertical, 2)
        } else {
            HStack(spacing: 8) {
                Image(systemName: "trophy")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.brandAccent)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Join the leaderboard")
                        .font(.system(size: 11.5, weight: .medium))
                    Text(leaderboard.isSignedIn
                         ? L("Turn on sharing in Settings to be ranked.")
                         : L("Sign in with GitHub to be ranked. Only totals are shared."))
                        .font(.system(size: 10.5))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                Button("Join") { openLeaderboardSettings() }
                    .controlSize(.small)
            }
            .padding(.vertical, 2)
        }
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
    let usd: Double
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
            Text(usd.asCompactCurrency())
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
