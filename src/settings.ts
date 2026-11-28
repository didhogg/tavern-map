import { layerAIFlagsRevision, resetLayerAIFlags, type LayerAIKind } from './layer-ai-store'
import { resetRealAIFlags } from './real-places'
import type { LayerAIPart, LayerChatState } from './layer-types'
import type { RealPlacePart, Settings } from './types'

export const MODULE_NAME = 'tavern-map'

export const WIKI_LANGS = ['en', 'ja', 'zh'] as const
export type WikiLang = (typeof WIKI_LANGS)[number]

/** Itinerary range (places and roads along the route), as a fraction of the map width. */
export const ITINERARY_RANGE_MIN = 0.001
export const ITINERARY_RANGE_MAX = 0.4

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  provider: 'osm',
  wikiLangs: ['en'],
  radiusM: 250,
  maxNearby: 6,
  depth: 2,
  showPois: true,
  showRoutePois: true,
  routePoiRadiusM: 100,
  realRouteMax: 8,
  realRouteCurrentOnly: false,
  realRouteSource: false,
  realRouteNote: false,
  realSourceAI: true,
  realWikiAI: false,
  realNearbyCoords: false,
  realNearbyNotes: false,
  realNearbySource: false,
  realNearbyWiki: false,
  realFavoriteType: true,
  realFavoriteCoords: false,
  realFavoriteSource: false,
  realFavoriteWiki: false,
  realMapContext: true,
  layerMapContext: false,
  realNoteAI: true,
  realNearbyAI: true,
  realNearbyType: true,
  realNearbyDistance: true,
  realFavoritesAI: true,
  realFavoriteNote: true,
  layerAIRevision: 0,
  layerSourceAI: true,
  layerWikiAI: false,
  layerNoteAI: true,
  layerRegionNoteAI: true,
  layerRegionSourceAI: false,
  layerNearbyAI: true,
  layerNearbyName: true,
  layerNearbyType: true,
  layerNearbyDirection: true,
  layerNearbyCoords: true,
  layerNearbyNotes: false,
  layerNearbySource: false,
  layerNearbyWiki: false,
  layerNearbyMax: 8,
  layerItineraryPoiRadius: 0.08,
  layerItineraryPoiMax: 8,
  layerItineraryPoisShow: true,
  layerItineraryPoisCurrentOnly: false,
  layerItineraryPoiSource: false,
  layerItineraryPoiNotes: false,
  layerItineraryRegionNotes: false,
  layerRoadNoteNearby: true,
  layerRoadNoteCurrentLeg: true,
  layerRoadNoteAllLegs: false,
  layerRoadSourceAI: false,
  layerFavoritesAI: false,
  layerFavoriteType: true,
  layerFavoriteCoords: true,
  layerFavoriteNote: true,
  layerFavoriteSource: false,
  layerFavoriteWiki: false,
  layerAutoExpandWiki: true,
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

  const realMapContext =
    typeof value.realMapContext === 'boolean'
      ? value.realMapContext
      : DEFAULT_SETTINGS.realMapContext
  const layerMapContext =
    typeof value.layerMapContext === 'boolean'
      ? value.layerMapContext
      : DEFAULT_SETTINGS.layerMapContext
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_SETTINGS.enabled,
    provider: 'osm',
    wikiLangs: wikiLangs.length > 0 ? wikiLangs : [...DEFAULT_SETTINGS.wikiLangs],
    radiusM: number(value.radiusM, DEFAULT_SETTINGS.radiusM, 25, 1000),
    maxNearby: Math.round(number(value.maxNearby, DEFAULT_SETTINGS.maxNearby, 0, 50)),
    depth: Math.round(number(value.depth, DEFAULT_SETTINGS.depth, 0, 10)),
    showPois: typeof value.showPois === 'boolean' ? value.showPois : true,
    showRoutePois:
      typeof value.showRoutePois === 'boolean'
        ? value.showRoutePois
        : DEFAULT_SETTINGS.showRoutePois,
    routePoiRadiusM: Math.round(
      number(value.routePoiRadiusM, DEFAULT_SETTINGS.routePoiRadiusM, 25, 500),
    ),
    realMapContext: layerMapContext ? false : realMapContext,
    layerMapContext,
    realRouteMax: Math.round(number(value.realRouteMax, DEFAULT_SETTINGS.realRouteMax, 1, 30)),
    realRouteCurrentOnly: value.realRouteCurrentOnly === true,
    realRouteSource: value.realRouteSource === true,
    realRouteNote: value.realRouteNote === true,
    realSourceAI: value.realSourceAI !== false,
    realWikiAI: value.realWikiAI === true,
    realNearbyCoords: value.realNearbyCoords === true,
    realNearbyNotes: value.realNearbyNotes === true,
    realNearbySource: value.realNearbySource === true,
    realNearbyWiki: value.realNearbyWiki === true,
    realFavoriteType: value.realFavoriteType !== false,
    realFavoriteCoords: value.realFavoriteCoords === true,
    realFavoriteSource: value.realFavoriteSource === true,
    realFavoriteWiki: value.realFavoriteWiki === true,
    realNoteAI: value.realNoteAI !== false,
    realNearbyAI: value.realNearbyAI !== false,
    realNearbyType: value.realNearbyType !== false,
    realNearbyDistance: value.realNearbyDistance !== false,
    realFavoritesAI: value.realFavoritesAI !== false,
    realFavoriteNote: value.realFavoriteNote !== false,
    layerAIRevision: number(value.layerAIRevision, 0, 0, Number.MAX_SAFE_INTEGER),
    layerSourceAI: value.layerSourceAI !== false,
    layerWikiAI: value.layerWikiAI === true,
    layerNoteAI: value.layerNoteAI !== false,
    layerRegionNoteAI: value.layerRegionNoteAI !== false,
    layerRegionSourceAI: value.layerRegionSourceAI === true,
    layerNearbyAI: value.layerNearbyAI !== false,
    layerNearbyName: value.layerNearbyName !== false,
    layerNearbyType: value.layerNearbyType !== false,
    layerNearbyDirection: value.layerNearbyDirection !== false,
    layerNearbyCoords: value.layerNearbyCoords !== false,
    layerNearbyNotes: value.layerNearbyNotes === true,
    layerNearbySource: value.layerNearbySource === true,
    layerNearbyWiki: value.layerNearbyWiki === true,
    layerNearbyMax: Math.round(
      number(value.layerNearbyMax, DEFAULT_SETTINGS.layerNearbyMax, 1, 50),
    ),
    layerItineraryPoiRadius: number(
      value.layerItineraryPoiRadius,
      DEFAULT_SETTINGS.layerItineraryPoiRadius,
      ITINERARY_RANGE_MIN,
      ITINERARY_RANGE_MAX,
    ),
    layerItineraryPoiMax: Math.round(
      number(value.layerItineraryPoiMax, DEFAULT_SETTINGS.layerItineraryPoiMax, 1, 30),
    ),
    layerItineraryPoisShow: value.layerItineraryPoisShow !== false,
    layerItineraryPoisCurrentOnly: value.layerItineraryPoisCurrentOnly === true,
    layerItineraryPoiSource: value.layerItineraryPoiSource === true,
    layerItineraryPoiNotes: value.layerItineraryPoiNotes === true,
    layerItineraryRegionNotes: value.layerItineraryRegionNotes === true,
    layerRoadNoteNearby: value.layerRoadNoteNearby !== false,
    layerRoadNoteCurrentLeg: value.layerRoadNoteCurrentLeg !== false,
    layerRoadNoteAllLegs: value.layerRoadNoteAllLegs === true,
    layerRoadSourceAI: value.layerRoadSourceAI === true,
    layerFavoritesAI: value.layerFavoritesAI === true,
    layerFavoriteType: value.layerFavoriteType !== false,
    layerFavoriteCoords: value.layerFavoriteCoords !== false,
    layerFavoriteNote: value.layerFavoriteNote !== false,
    layerFavoriteSource: value.layerFavoriteSource === true,
    layerFavoriteWiki: value.layerFavoriteWiki === true,
    layerAutoExpandWiki: value.layerAutoExpandWiki !== false,
  }
}

const LAYER_CONTENT_SWITCHES: Record<LayerAIKind, Partial<Record<LayerAIPart, Array<keyof Settings>>>> = {
  place: {
    source: ['layerSourceAI', 'layerNearbySource', 'layerFavoriteSource', 'layerItineraryPoiSource'],
    note: ['layerNoteAI', 'layerNearbyNotes', 'layerFavoriteNote', 'layerItineraryPoiNotes'],
    wiki: ['layerWikiAI', 'layerNearbyWiki', 'layerFavoriteWiki'],
  },
  region: {
    source: ['layerRegionSourceAI'],
    note: ['layerRegionNoteAI', 'layerItineraryRegionNotes'],
  },
  road: {
    source: ['layerRoadSourceAI'],
    note: ['layerRoadNoteNearby', 'layerRoadNoteCurrentLeg', 'layerRoadNoteAllLegs'],
  },
}

const REAL_CONTENT_SWITCHES: Record<RealPlacePart, Array<keyof Settings>> = {
  source: ['realSourceAI', 'realNearbySource', 'realFavoriteSource', 'realRouteSource'],
  note: ['realNoteAI', 'realNearbyNotes', 'realFavoriteNote', 'realRouteNote'],
  wiki: ['realWikiAI', 'realNearbyWiki', 'realFavoriteWiki'],
}

function resetAIOverrides(previous: Settings, current: Settings): void {
  const layers = new Map<LayerAIKind, Set<LayerAIPart>>()
  for (const kind of ['place', 'region', 'road'] as const) {
    const parts = (['source', 'wiki', 'note'] as const).filter((part) =>
      LAYER_CONTENT_SWITCHES[kind][part]?.some((key) => previous[key] !== current[key]),
    )
    if (parts.length) layers.set(kind, new Set(parts))
  }
  const policyChanged = layers.size > 0 ||
    previous.layerNearbyAI !== current.layerNearbyAI ||
    previous.layerFavoritesAI !== current.layerFavoritesAI ||
    previous.layerItineraryPoisShow !== current.layerItineraryPoisShow ||
    previous.layerItineraryPoisCurrentOnly !== current.layerItineraryPoisCurrentOnly
  current.layerAIRevision = previous.layerAIRevision + (policyChanged ? 1 : 0)
  resetLayerAIFlags(layers)
  resetRealAIFlags(new Set(
    (['source', 'wiki', 'note'] as const).filter((part) =>
      REAL_CONTENT_SWITCHES[part].some((key) => previous[key] !== current[key]),
    ),
  ))
}

export function layerContextRevision(settings: Settings): string {
  return `${settings.layerAIRevision}:${layerAIFlagsRevision()}`
}

export function layerContextNeedsRefresh(state: LayerChatState, settings: Settings): boolean {
  return Boolean(state.packageId) && (state.context?.aiRevision ?? '0:0') !== layerContextRevision(settings)
}

export function saveSettings(ctx: { extensionSettings?: Record<string, unknown>; saveSettingsDebounced?: () => void }, settings: Settings): void {
  if (!ctx.extensionSettings) return
  resetAIOverrides(loadSettings(ctx), settings)
  ctx.extensionSettings[MODULE_NAME] = { ...settings }
  ctx.saveSettingsDebounced?.()
}
