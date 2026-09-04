//! Bridge for the opt-in public leaderboard, the Windows/Linux counterpart of
//! `mac/Sources/CodeBurnMenubar/Data/LeaderboardService.swift`.
//!
//! Every operation is delegated to `codeburn leaderboard`, which already
//! implements the whole contract (device flow, session exchange, report
//! building, anti-abuse handling, 401 recovery). Nothing here speaks HTTP:
//!
//!   * one implementation of the protocol instead of two that can drift,
//!   * one session -- the CLI's `~/.config/codeburn/config.json` -- so the tray
//!     app and the terminal always agree on who is signed in, and
//!   * the bearer token never enters the webview. `read_account` deliberately
//!     reports only *whether* a `sessionToken` exists, never its value.
//!
//! Privacy posture, matching macOS: reading a board is anonymous and safe, and
//! the only commands that transmit anything (`join`, `upload`) run solely from
//! an explicit click.

use std::sync::Mutex;

use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::oneshot;
use tokio::time::{Duration, Instant};

use crate::cli::CodeburnCli;

/// Same default as the Swift client's `defaultServerURL` and the CLI's
/// `DEFAULT_LEADERBOARD_SERVER`.
const DEFAULT_SERVER: &str = "https://codeburn-leaderboard.tangyishun9846.workers.dev";
const SERVER_ENV: &str = "CODEBURN_LEADERBOARD_SERVER";

/// Stable API ids, mirrored from `src/leaderboard.ts`. Anything else is refused
/// before it can reach an argv.
const BOARDS: [&str; 3] = ["week", "month", "lifetime"];
const METRICS: [&str; 3] = ["output", "usd", "streak"];
pub const MAX_BOARD_LIMIT: u32 = 100;

/// A board read is one HTTP GET behind a Node start-up.
const BOARD_TIMEOUT_SECS: u64 = 90;
/// `join` and `upload` rebuild the month, lifetime and 30-day slices before
/// posting -- roughly three full `codeburn status` runs -- so they get far more
/// room than a payload fetch.
const ACTION_TIMEOUT_SECS: u64 = 300;
/// GitHub device codes expire long before this; the guard exists only so a
/// wedged child cannot linger for the life of the tray app.
const LOGIN_TIMEOUT_SECS: u64 = 20 * 60;

/// Event the streamed sign-in reports progress on.
pub const LOGIN_EVENT: &str = "codeburn://leaderboard-login";
/// Fallback for the verification URL, used only if the CLI's prompt is ever
/// reworded past the URL matcher. GitHub has served this path for the whole
/// life of the device flow.
const GITHUB_DEVICE_URL: &str = "https://github.com/login/device";

/// Cancel handle for the single in-flight sign-in. `signIn()` on macOS is
/// likewise one-at-a-time: starting another cancels the first.
static LOGIN_CANCEL: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);

// ---------------------------------------------------------------------------
// Stored account state
// ---------------------------------------------------------------------------

/// What the popover may know about the stored session. Deliberately not the
/// session token: the webview never needs it, so it never gets it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardAccount {
    pub signed_in: bool,
    pub login: Option<String>,
    pub avatar_url: Option<String>,
    /// The opt-in flag. False (the default) means nothing is ever uploaded.
    pub enabled: bool,
    pub last_upload_at: Option<String>,
    pub last_upload_error: Option<String>,
    pub server: String,
}

impl Default for LeaderboardAccount {
    fn default() -> Self {
        LeaderboardAccount {
            signed_in: false,
            login: None,
            avatar_url: None,
            enabled: false,
            last_upload_at: None,
            last_upload_error: None,
            server: DEFAULT_SERVER.to_string(),
        }
    }
}

fn read_leaderboard_block() -> Option<Value> {
    let bytes = std::fs::read(crate::config::config_path()).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    value.get("leaderboard").cloned()
}

/// Mirrors the CLI's `resolveLeaderboardServer`: the environment override wins
/// over the stored one, and a blank value falls through to the default.
fn resolve_server(stored: Option<&str>) -> String {
    for candidate in [std::env::var(SERVER_ENV).ok().as_deref(), stored] {
        let trimmed = candidate.map(str::trim).unwrap_or("");
        if !trimmed.is_empty() {
            return trimmed.trim_end_matches('/').to_string();
        }
    }
    DEFAULT_SERVER.to_string()
}

/// Reads `config.leaderboard` straight off disk rather than parsing
/// `codeburn leaderboard status`, whose output is prose in the user's language.
/// The CLI owns every write; this is a read of the file it just wrote.
pub fn read_account() -> LeaderboardAccount {
    let block = read_leaderboard_block();
    let field = |key: &str| {
        block
            .as_ref()
            .and_then(|b| b.get(key))
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|s| !s.is_empty())
    };
    LeaderboardAccount {
        signed_in: block
            .as_ref()
            .and_then(|b| b.get("sessionToken"))
            .and_then(Value::as_str)
            .is_some_and(|token| !token.is_empty()),
        login: field("login"),
        avatar_url: field("avatarUrl"),
        enabled: block
            .as_ref()
            .and_then(|b| b.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        last_upload_at: field("lastUploadAt"),
        last_upload_error: field("lastUploadError"),
        server: resolve_server(field("server").as_deref()),
    }
}

// ---------------------------------------------------------------------------
// Board reads and account actions
// ---------------------------------------------------------------------------

/// Turns a failed run into the CLI's own sentence. `withLeaderboardErrors`
/// writes the message on its own indented line, so the first non-empty stderr
/// line is exactly what the terminal would have shown the user.
fn cli_failure(run: &crate::cli::CliRun) -> anyhow::Error {
    let first = run
        .stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty());
    match first {
        Some(message) => anyhow!("{message}"),
        None => anyhow!("codeburn leaderboard {}", run.status),
    }
}

/// `codeburn leaderboard --format json`, returned verbatim. Anonymous when no
/// session is stored, and the CLI transparently retries unauthenticated if the
/// stored session turned out to be dead -- the same fallback the macOS popover
/// performs.
pub async fn fetch_board(cli: &CodeburnCli, board: &str, metric: &str, limit: u32) -> Result<Value> {
    if !BOARDS.contains(&board) {
        bail!("unknown leaderboard board");
    }
    if !METRICS.contains(&metric) {
        bail!("unknown leaderboard metric");
    }
    let limit = limit.clamp(1, MAX_BOARD_LIMIT).to_string();
    let run = cli
        .run_parts(
            &[
                "leaderboard",
                "--board",
                board,
                "--metric",
                metric,
                "--limit",
                &limit,
                "--format",
                "json",
            ],
            BOARD_TIMEOUT_SECS,
        )
        .await?;
    if !run.success {
        return Err(cli_failure(&run));
    }
    serde_json::from_str(&run.stdout)
        .map_err(|_| anyhow!("The leaderboard server sent a malformed response."))
}

/// The state-changing half. `join` and `upload` are the only two that transmit,
/// and both only ever run from a click. `delete` passes `--yes` because the
/// confirmation happened in the popover, where the user could actually read it.
pub async fn run_action(cli: &CodeburnCli, action: &str) -> Result<LeaderboardAccount> {
    let args: &[&str] = match action {
        "join" => &["leaderboard", "join"],
        "leave" => &["leaderboard", "leave"],
        "upload" => &["leaderboard", "upload"],
        "logout" => &["leaderboard", "logout"],
        "delete" => &["leaderboard", "delete", "--yes"],
        _ => bail!("unknown leaderboard action"),
    };
    let run = cli.run_parts(args, ACTION_TIMEOUT_SECS).await?;
    if !run.success {
        return Err(cli_failure(&run));
    }
    Ok(read_account())
}

// ---------------------------------------------------------------------------
// Sign-in (GitHub device flow, driven through the CLI)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginEvent {
    /// `code` once the device code is known, then exactly one terminal phase:
    /// `done`, `failed` or `cancelled`.
    pub phase: &'static str,
    pub user_code: Option<String>,
    pub verification_uri: Option<String>,
    pub message: Option<String>,
}

impl LoginEvent {
    fn code(user_code: String, verification_uri: String) -> Self {
        LoginEvent {
            phase: "code",
            user_code: Some(user_code),
            verification_uri: Some(verification_uri),
            message: None,
        }
    }

    fn terminal(phase: &'static str, message: Option<String>) -> Self {
        LoginEvent {
            phase,
            user_code: None,
            verification_uri: None,
            message,
        }
    }
}

/// `  │  WDJB-MJHT  │` -> `WDJB-MJHT`. The box is drawn from literal characters
/// the CLI never translates, so this survives every locale; the shape check
/// keeps a decorative rule (`└────┘`) from being mistaken for a code.
fn boxed_code(line: &str) -> Option<String> {
    let inner = line.trim().strip_prefix('│')?.strip_suffix('│')?.trim();
    if inner.is_empty() || inner.chars().count() > 32 {
        return None;
    }
    if !inner
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return None;
    }
    Some(inner.to_string())
}

/// Backstop for the box matcher: a bare `XXXX-XXXX` on a line of its own, which
/// is the shape GitHub has always issued.
fn bare_code(line: &str) -> Option<String> {
    let trimmed = line.trim();
    let (left, right) = trimmed.split_once('-')?;
    let group = |s: &str| s.len() == 4 && s.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    if group(left) && group(right) {
        Some(trimmed.to_string())
    } else {
        None
    }
}

/// First URL on the line, with trailing sentence punctuation (ASCII or CJK)
/// trimmed off. The prompt around it is localized; the URL is not.
fn first_url(line: &str) -> Option<String> {
    let start = line.find("https://").or_else(|| line.find("http://"))?;
    let rest = &line[start..];
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let url = rest[..end]
        .trim_end_matches(|c| matches!(c, '.' | ',' | ':' | '，' | '：' | '。' | '、' | ')' | '）'))
        .to_string();
    (url.len() > "https://".len()).then_some(url)
}

/// Accumulates what the login command prints until it can report a code.
#[derive(Default)]
struct LoginParser {
    user_code: Option<String>,
    verification_uri: Option<String>,
    announced: bool,
}

impl LoginParser {
    fn observe(&mut self, line: &str) -> Option<LoginEvent> {
        if self.verification_uri.is_none() {
            self.verification_uri = first_url(line);
        }
        if self.user_code.is_none() {
            self.user_code = boxed_code(line).or_else(|| bare_code(line));
        }
        if self.announced {
            return None;
        }
        let code = self.user_code.clone()?;
        self.announced = true;
        Some(LoginEvent::code(
            code,
            self.verification_uri
                .clone()
                .unwrap_or_else(|| GITHUB_DEVICE_URL.to_string()),
        ))
    }
}

/// Drops the cancel handle for the current flow, if any, which makes the
/// streaming task kill its child.
pub fn cancel_login() {
    if let Ok(mut guard) = LOGIN_CANCEL.lock() {
        if let Some(sender) = guard.take() {
            let _ = sender.send(());
        }
    }
}

/// Starts `codeburn leaderboard login` and streams its progress to the popover.
///
/// The command needs no stdin -- it prints a device code, polls GitHub, then
/// exchanges the result for a server session and stores it. That makes it
/// drivable from a GUI, but only if its stdout is read *as it arrives*: waiting
/// for exit would surface the code minutes after it expired. So this spawns the
/// child, watches its lines for the code and the verification URL, and reports
/// the exit verdict. Neither the GitHub token nor the session token is ever
/// printed by the CLI, so nothing sensitive passes through here.
pub async fn start_login(app: AppHandle, cli: CodeburnCli) -> Result<()> {
    cancel_login();
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    if let Ok(mut guard) = LOGIN_CANCEL.lock() {
        *guard = Some(cancel_tx);
    }

    let mut child = cli.spawn_streaming(&["leaderboard", "login"])?;
    let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
    let mut stderr = child.stderr.take().ok_or_else(|| anyhow!("no stderr"))?;
    let stderr_task = tauri::async_runtime::spawn(async move {
        let mut buf = String::new();
        let mut limited = (&mut stderr).take(64 * 1024);
        limited.read_to_string(&mut buf).await.ok();
        buf
    });

    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut parser = LoginParser::default();
        let deadline = Instant::now() + Duration::from_secs(LOGIN_TIMEOUT_SECS);
        let mut interrupted: Option<LoginEvent> = None;

        loop {
            tokio::select! {
                next = lines.next_line() => {
                    match next {
                        Ok(Some(line)) => {
                            if let Some(event) = parser.observe(&line) {
                                let _ = app.emit(LOGIN_EVENT, event);
                            }
                        }
                        // EOF or a broken pipe: the child is finishing, so fall
                        // through to the exit status for the verdict.
                        _ => break,
                    }
                }
                _ = &mut cancel_rx => {
                    interrupted = Some(LoginEvent::terminal("cancelled", None));
                    break;
                }
                _ = tokio::time::sleep_until(deadline) => {
                    interrupted = Some(LoginEvent::terminal(
                        "failed",
                        Some("The code expired before it was entered. Try again.".to_string()),
                    ));
                    break;
                }
            }
        }

        let event = match interrupted {
            Some(event) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                event
            }
            None => {
                let status = child.wait().await;
                let stderr = stderr_task.await.unwrap_or_default();
                match status {
                    Ok(status) if status.success() => LoginEvent::terminal("done", None),
                    Ok(_) => LoginEvent::terminal(
                        "failed",
                        stderr
                            .lines()
                            .map(str::trim)
                            .find(|line| !line.is_empty())
                            .map(str::to_string),
                    ),
                    Err(err) => LoginEvent::terminal("failed", Some(err.to_string())),
                }
            }
        };

        if let Ok(mut guard) = LOGIN_CANCEL.lock() {
            *guard = None;
        }
        let _ = app.emit(LOGIN_EVENT, event);
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact frame `codeburn leaderboard login` draws, plus the rules around
    /// it that must not be read as codes.
    #[test]
    fn boxed_code_reads_only_the_code_row() {
        assert_eq!(boxed_code("  │  WDJB-MJHT  │"), Some("WDJB-MJHT".to_string()));
        assert_eq!(boxed_code("  ┌─────────────┐"), None);
        assert_eq!(boxed_code("  └─────────────┘"), None);
        assert_eq!(boxed_code("  Waiting for you to authorize..."), None);
        // A rule accidentally wrapped in the side character is still not a code.
        assert_eq!(boxed_code("  │  ─────────  │"), None);
    }

    #[test]
    fn bare_code_is_the_backstop() {
        assert_eq!(bare_code("  WDJB-MJHT  "), Some("WDJB-MJHT".to_string()));
        assert_eq!(bare_code("2026-09-04"), None);
        assert_eq!(bare_code("not-a-code"), None);
    }

    /// Both localizations put the URL on a line of its own or inline; either way
    /// only the URL comes back, without the sentence punctuation after it.
    #[test]
    fn first_url_survives_localized_prompts() {
        assert_eq!(
            first_url("  Open https://github.com/login/device in your browser and enter this code:"),
            Some("https://github.com/login/device".to_string())
        );
        assert_eq!(
            first_url("  https://github.com/login/device"),
            Some("https://github.com/login/device".to_string())
        );
        assert_eq!(
            first_url("  在浏览器中打开 https://github.com/login/device。"),
            Some("https://github.com/login/device".to_string())
        );
        assert_eq!(first_url("  no link here"), None);
    }

    /// The parser announces once, and carries whatever URL it had seen by then.
    #[test]
    fn parser_announces_the_code_once() {
        let mut parser = LoginParser::default();
        assert!(parser.observe("").is_none());
        assert!(parser
            .observe("  Open https://github.com/login/device in your browser and enter this code:")
            .is_none());
        assert!(parser.observe("  ┌─────────────┐").is_none());
        let event = parser.observe("  │  WDJB-MJHT  │").expect("code announced");
        assert_eq!(event.phase, "code");
        assert_eq!(event.user_code.as_deref(), Some("WDJB-MJHT"));
        assert_eq!(
            event.verification_uri.as_deref(),
            Some("https://github.com/login/device")
        );
        assert!(parser.observe("  └─────────────┘").is_none());
    }

    /// A code printed before the URL still gets a usable link.
    #[test]
    fn parser_falls_back_to_the_github_device_url() {
        let mut parser = LoginParser::default();
        let event = parser.observe("│  WDJB-MJHT  │").expect("code announced");
        assert_eq!(event.verification_uri.as_deref(), Some(GITHUB_DEVICE_URL));
    }

    #[test]
    fn server_override_order_matches_the_cli() {
        // No env var set in the test process, so the stored value wins over the
        // default and a blank stored value falls through.
        assert_eq!(resolve_server(Some("https://example.test/")), "https://example.test");
        assert_eq!(resolve_server(Some("  ")), DEFAULT_SERVER);
        assert_eq!(resolve_server(None), DEFAULT_SERVER);
    }
}
