/// Translation layer for the tray popover, mirroring the semantics of the CLI's
/// `src/i18n.ts`. English is the source language: every key IS its English text,
/// so an untranslated key still renders correctly and a missing catalog degrades
/// to English rather than to placeholder ids.
///
///     t('Today')                       -> '今天'
///     t('%d calls', calls)             -> '61 次调用'
///     t('Loading %s…', label)          -> '正在加载 7 天…'
///
/// Placeholders are positional printf-style (%s, %d, %f, %%) so translators can
/// reorder them; %1$s / %2$s select an explicit argument.
///
/// The one structural difference from the CLI module: this bundle runs in a
/// webview with no filesystem, so catalogs are imported and bundled by Vite
/// instead of being read from disk, and components subscribe to language changes
/// (the language arrives with the first CLI payload, after the first paint).
import { useSyncExternalStore } from 'react'

import zhCN from './locales/zh-CN'

export const SUPPORTED_LANGUAGES = ['en', 'zh-CN'] as const
export type Language = (typeof SUPPORTED_LANGUAGES)[number]
export const DEFAULT_LANGUAGE: Language = 'en'

/// What the Settings panel stores: an explicit language, or `system` to follow
/// the CLI payload / the webview locale.
export type LanguageChoice = Language | 'system'

const CATALOGS: Record<Language, Record<string, string>> = {
  en: {},
  'zh-CN': zhCN,
}

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
}

export function isLanguageChoice(value: unknown): value is LanguageChoice {
  return value === 'system' || isLanguage(value)
}

/// Maps a POSIX/BCP-47 locale to a supported language. `zh_CN.UTF-8`, `zh-Hans`,
/// `zh` and `zh-SG` all resolve to Simplified Chinese; `zh-TW` / `zh-Hant` do
/// not (no Traditional catalog yet) and fall through to English.
export function languageFromLocale(locale: string | null | undefined): Language | undefined {
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
const listeners = new Set<() => void>()

/// Sets the active language for the whole webview and re-renders every component
/// that reads `useLanguage()`.
export function setLanguage(language: Language): void {
  if (language === active) return
  active = language
  catalog = CATALOGS[language] ?? {}
  try {
    document.documentElement.lang = language
  } catch {
    // Not fatal: the attribute only steers font fallback.
  }
  for (const listener of listeners) listener()
}

export function getLanguage(): Language {
  return active
}

/// Resolution order for the tray app, highest first:
///   1. the explicit choice in Settings (`system` falls through),
///   2. `payload.lang`, i.e. whatever `codeburn lang` resolved for the CLI,
///   3. the webview locale.
export function resolveLanguage(options: {
  chosen?: string | null
  payload?: string | null
  locale?: string | null
} = {}): Language {
  if (isLanguage(options.chosen)) return options.chosen
  const fromChosen = languageFromLocale(options.chosen)
  if (fromChosen) return fromChosen
  if (isLanguage(options.payload)) return options.payload
  const fromPayload = languageFromLocale(options.payload)
  if (fromPayload) return fromPayload
  const locale = options.locale ?? (typeof navigator === 'undefined' ? null : navigator.language)
  return languageFromLocale(locale) ?? DEFAULT_LANGUAGE
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/// Subscribes a component to language changes. The root component calls this, so
/// a language arriving with the first payload repaints the whole popover.
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

/// Plural helper. English keys carry both forms; a catalog may translate them to
/// the same string. With no extra args, `count` is the single argument.
export function tn(one: string, other: string, count: number, ...args: unknown[]): string {
  return t(count === 1 ? one : other, ...(args.length > 0 ? args : [count]))
}
