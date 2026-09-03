import AppKit
import SwiftUI

/// Settings pane for the opt-in public leaderboard: GitHub sign-in (device
/// flow), the sharing toggle with a plain statement of what is and is not
/// uploaded, manual upload with last-result feedback, rank, and the privacy
/// controls (delete my data, sign out).
struct LeaderboardSettingsTab: View {
    @Environment(LeaderboardService.self) private var leaderboard
    @State private var showDeleteConfirm = false

    var body: some View {
        @Bindable var leaderboard = leaderboard
        Form {
            Section("GitHub account") {
                LeaderboardSignInRow()
            }

            Section {
                Toggle("Share my spend on the public leaderboard", isOn: $leaderboard.isEnabled)
                if leaderboard.isEnabled, !leaderboard.isSignedIn {
                    Text("Sign in with GitHub above to start uploading.")
                        .font(.system(size: 11))
                        .foregroundStyle(.orange)
                }
                LeaderboardPrivacyText()
            } header: {
                Text("Participation")
            }

            Section {
                LeaderboardUploadRow()
            } header: {
                Text("Upload")
            }

            Section {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Delete my data")
                            .font(.system(size: 12, weight: .semibold))
                        Text("Removes your account, rank, and every report from the leaderboard server, then signs you out and turns sharing off.")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if leaderboard.isDeletingData {
                        ProgressView().controlSize(.small)
                    } else {
                        Button("Delete…", role: .destructive) { showDeleteConfirm = true }
                            .disabled(!leaderboard.isSignedIn)
                    }
                }
                .padding(.vertical, 4)
                .confirmationDialog("Delete your leaderboard data?", isPresented: $showDeleteConfirm) {
                    Button("Delete my data", role: .destructive) {
                        Task { try? await leaderboard.deleteMyData() }
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("This removes you from the public leaderboard immediately. Your local CodeBurn data is untouched.")
                }
            } header: {
                Text("Your data")
            }

            Section {
                HStack {
                    Text("Server")
                    Spacer()
                    Text(leaderboard.serverURL.absoluteString)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                Text("Override with the `CodeBurnLeaderboardServer` default if you run your own instance.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding()
        .task { await leaderboard.refreshConfig() }
    }
}

// MARK: - Sign in

private struct LeaderboardSignInRow: View {
    @Environment(LeaderboardService.self) private var leaderboard
    @State private var showSignOutConfirm = false

    var body: some View {
        switch leaderboard.signInState {
        case .idle:
            signedOut(message: L("Sign in with your GitHub account to appear on the leaderboard. Only your public login and avatar are used."))
        case let .failed(message):
            signedOut(message: message, isError: true)
        case .requestingCode:
            pending(title: L("Requesting a sign-in code…"))
        case let .waitingForUser(userCode, verificationURL, expiresAt):
            waiting(userCode: userCode, verificationURL: verificationURL, expiresAt: expiresAt)
        case .exchanging:
            pending(title: L("Signing in…"))
        case let .signedIn(user):
            signedIn(user)
        }
    }

    private func signedOut(message: String, isError: Bool = false) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: isError ? "exclamationmark.triangle.fill" : "person.crop.circle.badge.questionmark")
                .font(.system(size: 18))
                .foregroundStyle(isError ? Color.red : Color.secondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(isError ? L("Sign-in failed") : L("Not signed in"))
                    .font(.system(size: 12, weight: .semibold))
                Text(message)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button(isError ? L("Retry") : L("Sign in with GitHub")) { leaderboard.signIn() }
                .buttonStyle(.borderedProminent)
        }
        .padding(.vertical, 4)
    }

    private func pending(title: String) -> some View {
        HStack(spacing: 12) {
            ProgressView().controlSize(.small).frame(width: 22)
            Text(title)
                .font(.system(size: 12, weight: .semibold))
            Spacer()
            Button("Cancel") { leaderboard.cancelSignIn() }
        }
        .padding(.vertical, 4)
    }

    private func waiting(userCode: String, verificationURL: URL, expiresAt: Date) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Enter this code on GitHub to finish signing in:")
                .font(.system(size: 12, weight: .semibold))
            HStack(spacing: 14) {
                Text(userCode)
                    .font(.system(size: 32, weight: .bold, design: .monospaced))
                    .tracking(4)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(Color.secondary.opacity(0.10)))
                VStack(alignment: .leading, spacing: 6) {
                    Button("Open GitHub") { NSWorkspace.shared.open(verificationURL) }
                        .buttonStyle(.borderedProminent)
                    Button("Copy code") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(userCode, forType: .string)
                    }
                }
            }
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Waiting for you to authorize in the browser…")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                Text(L("Expires \(expiresAt.formatted(date: .omitted, time: .shortened))"))
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                Spacer()
                Button("Cancel") { leaderboard.cancelSignIn() }
            }
            Text(verificationURL.absoluteString)
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(.tertiary)
                .textSelection(.enabled)
        }
        .padding(.vertical, 4)
    }

    private func signedIn(_ user: LeaderboardUser) -> some View {
        HStack(alignment: .center, spacing: 12) {
            LeaderboardAvatar(urlString: user.avatarUrl, size: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(user.login)
                    .font(.system(size: 12, weight: .semibold))
                Text("Signed in with GitHub")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Sign out") { showSignOutConfirm = true }
                .confirmationDialog("Sign out of the leaderboard?", isPresented: $showSignOutConfirm) {
                    Button("Sign out", role: .destructive) {
                        Task { await leaderboard.signOut() }
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("Uploads stop until you sign in again. Your entries stay on the board; use Delete my data to remove them.")
                }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Privacy text

private struct LeaderboardPrivacyText: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("The leaderboard is opt-in and public. While sharing is on and you are signed in, CodeBurn uploads a small summary about once an hour.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text("What is uploaded")
                    .font(.system(size: 11, weight: .semibold))
                bullet(L("Total spend in USD for this month and lifetime"))
                bullet(L("Total tokens and call counts for this month and lifetime"))
                bullet(L("Spend split per provider (Claude, Codex, Cursor, …)"))
                bullet(L("Your GitHub login and avatar, and the CodeBurn version"))
            }
            VStack(alignment: .leading, spacing: 3) {
                Text("Never uploaded")
                    .font(.system(size: 11, weight: .semibold))
                bullet(L("Project names, file paths, or branch names"))
                bullet(L("Prompts, transcripts, or session details"))
                bullet(L("Model names, API keys, or any credentials"))
            }
        }
        .padding(.vertical, 2)
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text("•")
            Text(text)
        }
        .font(.system(size: 11))
        .foregroundStyle(.secondary)
    }
}

// MARK: - Upload

private struct LeaderboardUploadRow: View {
    @Environment(LeaderboardService.self) private var leaderboard

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(statusTitle)
                        .font(.system(size: 12, weight: .semibold))
                    Text(statusDetail)
                        .font(.system(size: 11))
                        .foregroundStyle(leaderboard.lastUploadError == nil ? Color.secondary : Color.red)
                        .lineLimit(3)
                }
                Spacer()
                if leaderboard.isUploading {
                    ProgressView().controlSize(.small)
                } else {
                    Button("Upload now") { Task { await leaderboard.upload() } }
                        .disabled(!leaderboard.isParticipating)
                }
            }
            HStack(spacing: 16) {
                rankLabel(L("This month"), leaderboard.myRank.month)
                rankLabel(L("Lifetime"), leaderboard.myRank.lifetime)
                if leaderboard.lastReportFlagged {
                    Label(L("Hidden from public boards pending review"), systemImage: "eye.slash")
                        .font(.system(size: 11))
                        .foregroundStyle(.orange)
                }
            }
            if let report = leaderboard.lastReport {
                Text(L("Last report: \(report.month) \(report.monthUSD.asUSD()) · lifetime \(report.lifetimeUSD.asUSD()) · \(Double(report.lifetimeTokens).asCompactTokens()) tokens"))
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
            if let configError = leaderboard.configError, leaderboard.config == nil {
                Text(configError)
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
            }
        }
        .padding(.vertical, 4)
    }

    private var statusTitle: String {
        if !leaderboard.isSignedIn { return L("Not uploading") }
        if !leaderboard.isEnabled { return L("Sharing is off") }
        if leaderboard.isUploading { return L("Uploading…") }
        if leaderboard.lastUploadError != nil { return L("Last upload failed") }
        return L("Uploading automatically")
    }

    private var statusDetail: String {
        if let error = leaderboard.lastUploadError { return error }
        if let at = leaderboard.lastUploadAt {
            return L("Last upload \(at.formatted(date: .abbreviated, time: .shortened)).")
        }
        if leaderboard.isParticipating { return L("No upload yet. The first one runs after usage data loads.") }
        return L("Sign in and turn on sharing to upload.")
    }

    private func rankLabel(_ title: String, _ rank: Int?) -> some View {
        HStack(spacing: 4) {
            Text(title)
                .foregroundStyle(.secondary)
            Text(rank.map { "#\($0)" } ?? "—")
                .fontWeight(.semibold)
                .monospacedDigit()
        }
        .font(.system(size: 11))
    }
}

// MARK: - Avatar

/// Round GitHub avatar with a neutral placeholder while loading or offline.
struct LeaderboardAvatar: View {
    let urlString: String?
    let size: CGFloat

    var body: some View {
        Group {
            if let urlString, let url = URL(string: urlString) {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        placeholder
                    }
                }
            } else {
                placeholder
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }

    private var placeholder: some View {
        Circle()
            .fill(Color.secondary.opacity(0.18))
            .overlay(
                Image(systemName: "person.fill")
                    .font(.system(size: size * 0.5))
                    .foregroundStyle(.secondary))
    }
}
