/// Dashboard-local translation layer. Same contract as the CLI's `src/i18n.ts`
/// (English text IS the key, positional printf placeholders, an unknown key
/// renders as the key i.e. English), re-implemented here because the dashboard
/// is a separate Vite bundle: it cannot import the CLI module and cannot read a
/// catalog off disk at runtime, so the catalogs are bundled instead.
///
///     t('Today')                       -> '今天'
///     t('%d calls', calls)             -> '61 次调用'
///
/// The active language arrives with the usage payload (`payload.lang`, written
/// by src/menubar-json.ts), i.e. after first paint, so language changes are
/// published to React through `useLanguage()`.
import { useSyncExternalStore } from 'react'

import zhCN from './locales/zh-CN'

export const SUPPORTED_LANGUAGES = ['en', 'zh-CN'] as const
export type Language = (typeof SUPPORTED_LANGUAGES)[number]
export const DEFAULT_LANGUAGE: Language = 'en'

// English is the key, so its catalog is empty by construction.
const CATALOGS: Record<Language, Record<string, string>> = { en: {}, 'zh-CN': zhCN }

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
}

/// Maps a POSIX/BCP-47 locale to a supported language. `zh_CN.UTF-8`, `zh-Hans`,
/// `zh` and `zh-SG` all resolve to Simplified Chinese; `zh-TW` / `zh-Hant` do
/// not (no Traditional catalog yet) and fall through to English.
export function languageFromLocale(locale: string | undefined): Language | undefined {
  if (!locale) return undefined
  const tag = locale.replace('_', '-').split('.')[0]!.toLowerCase()
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
const listeners = new Set<() => void>()

/// Sets the active language for the whole page and re-renders the subscribers.
export function setLanguage(language: Language): void {
  if (language === active) return
  active = language
  catalog = CATALOGS[language] ?? {}
  for (const listener of [...listeners]) listener()
}

export function getLanguage(): Language {
  return active
}

function browserLanguage(): Language {
  if (typeof navigator === 'undefined') return DEFAULT_LANGUAGE
  const tags = [...(navigator.languages ?? []), navigator.language]
  for (const tag of tags) {
    const resolved = languageFromLocale(tag)
    if (resolved) return resolved
  }
  return DEFAULT_LANGUAGE
}

/// Adopts the language the server reports in the usage payload. A server that
/// predates the field sends nothing, and the browser locale decides instead —
/// an unresolvable value is English, never a guess from the browser, because a
/// server that named a language has already made the choice.
export function applyServerLanguage(lang: string | undefined): void {
  if (lang) {
    setLanguage(isLanguage(lang) ? lang : (languageFromLocale(lang) ?? DEFAULT_LANGUAGE))
    return
  }
  setLanguage(browserLanguage())
}

type BootstrapLike = { devices?: Array<{ local?: boolean; payload?: { lang?: string } }> }

/// Picks the language up from the server-injected bootstrap before first paint,
/// so the dashboard does not render English and then flip.
export function initLanguage(): void {
  const boot =
    typeof window === 'undefined'
      ? undefined
      : (window as unknown as { __CODEBURN_BOOTSTRAP__?: BootstrapLike }).__CODEBURN_BOOTSTRAP__
  applyServerLanguage(boot?.devices?.find((d) => d.local)?.payload?.lang)
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

/// Re-renders the caller when the language changes. Call it in any component
/// that translates inside a `useMemo` and add the result to the dependency
/// list, so cached labels are rebuilt when the payload's language lands.
export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage)
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

/// Plural helper. English keys carry both forms; a catalog may translate them
/// to the same string.
export function tn(one: string, other: string, count: number, ...args: unknown[]): string {
  return t(count === 1 ? one : other, ...(args.length > 0 ? args : [count]))
}

/// Translates `key` and returns the text on either side of its FIRST `%s` (or
/// `%1$s`) instead of substituting it, so the caller can render that one value
/// as its own element — a monospaced command, a bold number. Remaining
/// placeholders must be explicitly indexed (`%2$s`) and are filled from `args`.
/// This keeps such a sentence a single translatable key, so the translation can
/// still move the value within it.
export function tsplit(key: string, ...args: unknown[]): [string, string] {
  const template = catalog[key] ?? key
  const at = template.search(/%(?:1\$)?s/)
  if (at < 0) return [format(template, args), '']
  const marker = template.slice(at).startsWith('%1$s') ? 4 : 2
  return [format(template.slice(0, at), args), format(template.slice(at + marker), args)]
}
