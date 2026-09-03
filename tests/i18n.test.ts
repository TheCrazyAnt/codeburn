import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_LANGUAGE,
  getLanguage,
  isLanguage,
  languageFromLocale,
  resolveLanguage,
  setLanguage,
  t,
  tn,
} from '../src/i18n.js'

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

describe('language resolution', () => {
  it('prefers CODEBURN_LANG over the stored config and the system locale', () => {
    expect(resolveLanguage({ configured: 'en', env: { CODEBURN_LANG: 'zh-CN', LANG: 'en_US.UTF-8' } })).toBe('zh-CN')
  })

  it('accepts a locale (not just a language tag) in CODEBURN_LANG', () => {
    expect(resolveLanguage({ env: { CODEBURN_LANG: 'zh_CN.UTF-8' } })).toBe('zh-CN')
  })

  it('falls back to the stored config when no env override is set', () => {
    expect(resolveLanguage({ configured: 'zh-CN', env: { LANG: 'en_US.UTF-8' } })).toBe('zh-CN')
  })

  it('ignores an unsupported configured value and uses the system locale', () => {
    expect(resolveLanguage({ configured: 'fr-FR', env: { LANG: 'zh_CN.UTF-8' } })).toBe('zh-CN')
  })

  it('defaults to English when nothing is set', () => {
    expect(resolveLanguage({ env: {} })).toBe('en')
  })

  it('reads LC_ALL ahead of LANG', () => {
    expect(resolveLanguage({ env: { LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' } })).toBe('zh-CN')
  })
})

describe('languageFromLocale', () => {
  it('maps Simplified Chinese locales', () => {
    for (const locale of ['zh', 'zh-CN', 'zh_CN.UTF-8', 'zh-Hans', 'zh-SG']) {
      expect(languageFromLocale(locale)).toBe('zh-CN')
    }
  })

  it('does not claim Traditional Chinese, which has no catalog', () => {
    for (const locale of ['zh-TW', 'zh-Hant', 'zh_HK', 'zh-MO']) {
      expect(languageFromLocale(locale)).toBeUndefined()
    }
  })

  it('treats the C/POSIX locale as unset', () => {
    expect(languageFromLocale('C')).toBeUndefined()
    expect(languageFromLocale('POSIX')).toBeUndefined()
    expect(languageFromLocale(undefined)).toBeUndefined()
  })

  it('returns undefined for languages we do not ship', () => {
    expect(languageFromLocale('fr_FR.UTF-8')).toBeUndefined()
  })
})

describe('isLanguage', () => {
  it('accepts only the shipped languages', () => {
    expect(isLanguage('en')).toBe(true)
    expect(isLanguage('zh-CN')).toBe(true)
    expect(isLanguage('zh')).toBe(false)
    expect(isLanguage(undefined)).toBe(false)
    expect(isLanguage(42)).toBe(false)
  })
})

describe('t', () => {
  it('returns the key untouched in the default language', () => {
    expect(getLanguage()).toBe('en')
    expect(t('Today')).toBe('Today')
  })

  it('substitutes positional placeholders in order', () => {
    expect(t('%s spent on %s', '$12.00', 'Monday')).toBe('$12.00 spent on Monday')
  })

  it('rounds %d and passes %f through', () => {
    expect(t('%d calls', 61.4)).toBe('61 calls')
    expect(t('%f x', 1.5)).toBe('1.5 x')
  })

  it('supports explicit argument positions so translations can reorder', () => {
    expect(t('%2$s then %1$s', 'a', 'b')).toBe('b then a')
  })

  it('renders %% as a literal percent', () => {
    expect(t('90%% cache hit')).toBe('90% cache hit')
  })

  it('leaves a placeholder alone when the argument is missing', () => {
    expect(t('%s and %s', 'only')).toBe('only and %s')
  })

  it('does not touch a key with no arguments', () => {
    expect(t('100% local')).toBe('100% local')
  })
})

describe('tn', () => {
  it('picks the singular key for exactly one', () => {
    expect(tn('%d call', '%d calls', 1)).toBe('1 call')
  })

  it('picks the plural key otherwise', () => {
    expect(tn('%d call', '%d calls', 0)).toBe('0 calls')
    expect(tn('%d call', '%d calls', 5)).toBe('5 calls')
  })
})

describe('a missing or partial catalog', () => {
  it('falls back to English keys rather than failing', () => {
    setLanguage('zh-CN')
    // Whatever the shipped catalog contains, an unknown key must render as
    // its English self instead of an empty string or a placeholder id.
    expect(t('a key no catalog will ever contain')).toBe('a key no catalog will ever contain')
  })
})
