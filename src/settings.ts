import type { Settings } from './types'

export const MODULE_NAME = 'tavern-map'

export const WIKI_LANGS = ['en', 'ja', 'zh'] as const
export type WikiLang = (typeof WIKI_LANGS)[number]

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  provider: 'osm',
  wikiLangs: ['en'],
  radiusM: 250,
  maxNearby: 6,
  maxWikiChars: 700,
  tokenBudget: 900,
  depth: 2,
}

export function loadSettings(ctx: { extensionSettings?: Record<string, unknown> }): Settings {
  const raw = ctx.extensionSettings?.[MODULE_NAME]
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS }
  const value = raw as Partial<Settings>
  const number = (input: unknown, fallback: number, min: number, max: number): number => {
    if (typeof input !== 'number' || !Number.isFinite(input)) return fallback
    return Math.min(max, Math.max(min, input))
  }
  const legacyLang = (value as { wikiLang?: unknown }).wikiLang
  const rawLangs = Array.isArray(value.wikiLangs)
    ? value.wikiLangs
    : typeof legacyLang === 'string'
      ? [legacyLang]
      : []
  const wikiLangs = Array.from(
    new Set(
      rawLangs.filter(
        (lang): lang is string =>
          typeof lang === 'string' && (WIKI_LANGS as readonly string[]).includes(lang),
      ),
    ),
  ).slice(0, 5)

  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_SETTINGS.enabled,
    provider: 'osm',
    wikiLangs: wikiLangs.length > 0 ? wikiLangs : [...DEFAULT_SETTINGS.wikiLangs],
    radiusM: number(value.radiusM, DEFAULT_SETTINGS.radiusM, 50, 1000),
    maxNearby: Math.round(number(value.maxNearby, DEFAULT_SETTINGS.maxNearby, 0, 12)),
    maxWikiChars: Math.round(number(value.maxWikiChars, DEFAULT_SETTINGS.maxWikiChars, 200, 1200)),
    tokenBudget: Math.round(number(value.tokenBudget, DEFAULT_SETTINGS.tokenBudget, 300, 2000)),
    depth: Math.round(number(value.depth, DEFAULT_SETTINGS.depth, 0, 10)),
  }
}

export function saveSettings(ctx: { extensionSettings?: Record<string, unknown>; saveSettingsDebounced?: () => void }, settings: Settings): void {
  if (!ctx.extensionSettings) return
  ctx.extensionSettings[MODULE_NAME] = { ...settings }
  ctx.saveSettingsDebounced?.()
}
