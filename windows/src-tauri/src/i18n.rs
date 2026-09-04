//! Minimal translation layer for the strings the Rust side owns: the tray
//! context menu and the error messages it surfaces to the webview.
//!
//! Mirrors the contract of `src/i18n.ts` on the CLI side: English text IS the
//! key, so a missing translation renders English rather than a placeholder id,
//! and the language resolves as `CODEBURN_LANG` > the CLI's `config.json`
//! `lang` > the OS locale > English. The webview has its own copy of the
//! catalog; keeping this one tiny (only what Rust renders) avoids shipping the
//! whole catalog twice.
use std::env;
use std::sync::RwLock;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Language {
    #[default]
    English,
    SimplifiedChinese,
}

impl Language {
    pub fn as_tag(self) -> &'static str {
        match self {
            Language::English => "en",
            Language::SimplifiedChinese => "zh-CN",
        }
    }

    /// Parses a language tag or POSIX locale. Traditional Chinese has no
    /// catalog, so it deliberately falls through to English rather than
    /// showing Simplified text to a Traditional reader.
    pub fn from_locale(raw: &str) -> Option<Self> {
        let tag = raw.replace('_', "-");
        let tag = tag.split('.').next().unwrap_or("").to_ascii_lowercase();
        if tag.is_empty() || tag == "c" || tag == "posix" {
            return None;
        }
        if tag.starts_with("zh") {
            if ["hant", "tw", "hk", "mo"].iter().any(|v| tag.contains(v)) {
                return None;
            }
            return Some(Language::SimplifiedChinese);
        }
        if tag.starts_with("en") {
            return Some(Language::English);
        }
        None
    }
}

static ACTIVE: RwLock<Language> = RwLock::new(Language::English);

pub fn set_language(language: Language) {
    if let Ok(mut active) = ACTIVE.write() {
        *active = language;
    }
}

pub fn language() -> Language {
    ACTIVE.read().map(|l| *l).unwrap_or_default()
}

/// Resolution order: `CODEBURN_LANG` (a tag or a locale), then the `lang` the
/// CLI stored in `config.json`, then the OS locale, then English.
pub fn resolve_language(configured: Option<&str>) -> Language {
    if let Ok(forced) = env::var("CODEBURN_LANG") {
        if let Some(language) = Language::from_locale(&forced) {
            return language;
        }
    }
    if let Some(language) = configured.and_then(Language::from_locale) {
        return language;
    }
    for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(value) = env::var(key) {
            if let Some(language) = Language::from_locale(&value) {
                return language;
            }
        }
    }
    os_locale().as_deref().and_then(Language::from_locale).unwrap_or_default()
}

/// Windows does not set the POSIX locale variables, so ask the OS directly.
#[cfg(target_os = "windows")]
fn os_locale() -> Option<String> {
    // `Get-Culture` is slower than the Win32 call but needs no extra crate and
    // runs once at startup.
    use std::process::Command;
    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", "(Get-Culture).Name"])
        .output()
        .ok()?;
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if name.is_empty() { None } else { Some(name) }
}

#[cfg(not(target_os = "windows"))]
fn os_locale() -> Option<String> {
    None
}

/// Translates one of the strings this crate renders. Unknown keys return the
/// key, which is the English text.
pub fn t(key: &str) -> String {
    match language() {
        Language::English => key.to_string(),
        Language::SimplifiedChinese => zh_cn(key).unwrap_or(key).to_string(),
    }
}

fn zh_cn(key: &str) -> Option<&'static str> {
    Some(match key {
        // Tray context menu
        "Open CodeBurn" => "打开 CodeBurn",
        "Refresh" => "刷新",
        "Toggle Dark/Light" => "切换深色/浅色",
        "Open Full Report" => "打开完整报告",
        "Quit CodeBurn" => "退出 CodeBurn",
        // Plan windows
        "5-hour window" => "5 小时窗口",
        "7-day total" => "7 天合计",
        "7-day Opus" => "7 天 Opus",
        "7-day Sonnet" => "7 天 Sonnet",
        "Subscription" => "订阅",
        // Errors surfaced in the UI
        "Claude is refreshing its session. This clears itself once Claude Code renews the token; run `claude login` if it persists." =>
            "Claude 正在刷新会话。Claude Code 续期 token 后会自动恢复；若持续出现，请运行 `claude login`。",
        "Claude session is no longer authorized" => "Claude 会话已失效，需要重新登录",
        "failed to read Claude credentials" => "无法读取 Claude 凭证",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simplified_chinese_locales() {
        for raw in ["zh", "zh-CN", "zh_CN.UTF-8", "zh-Hans", "zh-SG"] {
            assert_eq!(Language::from_locale(raw), Some(Language::SimplifiedChinese), "{raw}");
        }
    }

    #[test]
    fn leaves_traditional_chinese_to_english() {
        for raw in ["zh-TW", "zh-Hant", "zh_HK", "zh-MO"] {
            assert_eq!(Language::from_locale(raw), None, "{raw}");
        }
    }

    #[test]
    fn ignores_unset_and_unknown_locales() {
        for raw in ["", "C", "POSIX", "fr_FR.UTF-8"] {
            assert_eq!(Language::from_locale(raw), None, "{raw}");
        }
    }

    /// The `set_language` command answers with `as_tag` and the webview stores
    /// that answer, so a tag that will not parse back would silently pin the
    /// tray to English on the next switch.
    #[test]
    fn every_tag_parses_back_to_its_own_language() {
        for language in [Language::English, Language::SimplifiedChinese] {
            assert_eq!(Language::from_locale(language.as_tag()), Some(language));
        }
    }

    #[test]
    fn configured_language_beats_the_os_locale() {
        assert_eq!(resolve_language(Some("zh-CN")), Language::SimplifiedChinese);
    }

    #[test]
    fn unknown_keys_fall_back_to_english() {
        set_language(Language::SimplifiedChinese);
        assert_eq!(t("no catalog will ever hold this"), "no catalog will ever hold this");
        assert_eq!(t("Refresh"), "刷新");
        set_language(Language::English);
        assert_eq!(t("Refresh"), "Refresh");
    }
}
