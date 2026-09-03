/// Shared translation layer for the CLI, the web dashboard payload and the
/// Windows tray app. English is the source language: every key IS its English
/// text, so an untranslated key still renders correctly and a missing locale
/// file degrades to English rather than to placeholder ids.
///
///     t('Today')                       -> '今天'
///     t('%d calls', calls)             -> '61 次调用'
///     t('Saved %s', amount)            -> '已省下 $1.20'
///
/// Placeholders are positional printf-style (%s, %d, %%) so translators can
/// reorder them; %1$s / %2$s select an explicit argument.
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

export const SUPPORTED_LANGUAGES = ['en', 'zh-CN'] as const
export type Language = (typeof SUPPORTED_LANGUAGES)[number]
export const DEFAULT_LANGUAGE: Language = 'en'

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
}

/// Maps a POSIX/BCP-47 locale to a supported language. `zh_CN.UTF-8`, `zh-Hans`,
/// `zh` and `zh-SG` all resolve to Simplified Chinese; `zh-TW` / `zh-Hant` do
/// not (no Traditional catalog yet) and fall through to English.
export function languageFromLocale(locale: string | undefined): Language | undefined {
  if (!locale) return undefined
  const tag = locale.replace('_', '-').split('.')[0].toLowerCase()
  if (tag === 'c' || tag === 'posix') return undefined
  if (tag.startsWith('zh')) {
    if (tag.includes('hant') || tag.includes('tw') || tag.includes('hk') || tag.includes('mo')) return undefined
    return 'zh-CN'
  }
  if (tag.startsWith('en')) return 'en'
  return undefined
}

let active: Language = DEFAULT_LANGUAGE
let catalog: Record<string, string> = {}

function localesDir(): string {
  // Resolved relative to this module so it works from src/ under tsx and from
  // dist/ after the bundle step (scripts copy locales next to the bundle).
  return join(dirname(fileURLToPath(import.meta.url)), 'locales')
}

function loadCatalog(language: Language): Record<string, string> {
  if (language === DEFAULT_LANGUAGE) return {}
  try {
    const raw = readFileSync(join(localesDir(), `${language}.json`), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.length > 0) out[key] = value
    }
    return out
  } catch {
    // A missing or corrupt catalog must never break the CLI: fall back to the
    // English keys.
    return {}
  }
}

/// Sets the active language process-wide. Callers resolve the language first
/// (env > config > system locale) via `resolveLanguage`.
export function setLanguage(language: Language): void {
  active = language
  catalog = loadCatalog(language)
}

export function getLanguage(): Language {
  return active
}

/// `CODEBURN_LANG` wins so a single command can be forced to English without
/// touching the stored config (useful for bug reports and scripts).
export function resolveLanguage(options: {
  configured?: string
  env?: NodeJS.ProcessEnv
} = {}): Language {
  const env = options.env ?? process.env
  const forced = env.CODEBURN_LANG
  if (isLanguage(forced)) return forced
  const fromForcedLocale = languageFromLocale(forced)
  if (fromForcedLocale) return fromForcedLocale
  if (isLanguage(options.configured)) return options.configured
  return languageFromLocale(env.LC_ALL || env.LC_MESSAGES || env.LANG) ?? DEFAULT_LANGUAGE
}

function format(template: string, args: unknown[]): string {
  let auto = 0
  return template.replace(/%(?:(\d+)\$)?([sdf%])/g, (match, position: string | undefined, kind: string) => {
    if (kind === '%') return '%'
    const index = position ? Number(position) - 1 : auto++
    const value = args[index]
    if (value === undefined) return match
    if (kind === 'd') {
      const n = Number(value)
      return Number.isFinite(n) ? String(Math.round(n)) : String(value)
    }
    if (kind === 'f') {
      const n = Number(value)
      return Number.isFinite(n) ? String(n) : String(value)
    }
    return String(value)
  })
}

/// Translates `key` and substitutes positional arguments. Unknown keys return
/// the key itself, which is the English text.
export function t(key: string, ...args: unknown[]): string {
  const template = catalog[key] ?? key
  return args.length > 0 ? format(template, args) : template
}

/// Plural helper for the handful of places that need it. English keys carry
/// both forms; a catalog may translate them to the same string.
export function tn(one: string, other: string, count: number, ...args: unknown[]): string {
  return t(count === 1 ? one : other, ...(args.length > 0 ? args : [count]))
}
