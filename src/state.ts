import type { MapState, RouteItinerary, StContext } from './types'

function validItinerary(raw: unknown): RouteItinerary | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Partial<RouteItinerary>
  const from = value.from
  const to = value.to
  if (
    !from ||
    !to ||
    typeof from.name !== 'string' ||
    typeof to.name !== 'string' ||
    !Number.isFinite(from.lat) ||
    !Number.isFinite(from.lng) ||
    !Number.isFinite(to.lat) ||
    !Number.isFinite(to.lng)
  ) {
    return undefined
  }
  const steps = Array.isArray(value.steps)
    ? value.steps
        .filter(
          (step) =>
            step &&
            typeof step.instruction === 'string' &&
            Number.isFinite(step.distance) &&
            Number.isFinite(step.duration),
        )
        .slice(0, 40)
        .map((step) => ({
          instruction: step.instruction,
          name: typeof step.name === 'string' ? step.name : undefined,
          distance: step.distance,
          duration: step.duration,
        }))
    : []
  return {
    from: {
      id: typeof from.id === 'string' ? from.id : undefined,
      name: from.name,
      lat: from.lat,
      lng: from.lng,
    },
    to: {
      id: typeof to.id === 'string' ? to.id : undefined,
      name: to.name,
      lat: to.lat,
      lng: to.lng,
    },
    distance: Number.isFinite(value.distance) ? Number(value.distance) : 0,
    duration: Number.isFinite(value.duration) ? Number(value.duration) : 0,
    steps,
    fallback: Boolean(value.fallback),
    showToAI: Boolean(value.showToAI),
    updatedAt: Number.isFinite(value.updatedAt) ? Number(value.updatedAt) : Date.now(),
  }
}

export const DEFAULT_STATE: MapState = {
  version: 1,
  enabled: true,
  center: { lat: 35.6595, lng: 139.7005 },
  zoom: 14,
  nearby: [],
  wiki: [],
  stars: [],
  savedPlaces: [],
  poiBriefs: [],
  poiAllToAI: false,
  updatedAt: Date.now(),
}

export function loadState(ctx: StContext): MapState {
  const base = structuredClone(DEFAULT_STATE)
  const raw = ctx.chatMetadata?.['tavern-map']
  if (!raw || typeof raw !== 'object' || (raw as MapState).version !== 1) return base

  const value = raw as Partial<MapState>
  const center = value.center
  return {
    ...base,
    ...value,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : base.enabled,
    center:
      center && Number.isFinite(center.lat) && Number.isFinite(center.lng)
        ? { lat: center.lat, lng: center.lng }
        : base.center,
    zoom: typeof value.zoom === 'number' && Number.isFinite(value.zoom) ? value.zoom : base.zoom,
    place:
      value.place && typeof value.place.name === 'string' && Number.isFinite(value.place.lat) && Number.isFinite(value.place.lng)
        ? value.place
        : undefined,
    nearby: Array.isArray(value.nearby)
      ? value.nearby.filter(
          (place) => place && typeof place.name === 'string' && Number.isFinite(place.lat) && Number.isFinite(place.lng),
        )
      : [],
    wiki: Array.isArray(value.wiki)
      ? value.wiki
          .filter(
            (candidate) =>
              candidate &&
              typeof candidate.title === 'string' &&
              Number.isFinite(candidate.pageId) &&
              Number.isFinite(candidate.dist),
          )
          .map((candidate) => ({
            ...candidate,
            lang: typeof candidate.lang === 'string' ? candidate.lang : 'en',
          }))
      : [],
    stars: Array.isArray(value.stars)
      ? value.stars
          .filter(
            (page) =>
              page &&
              typeof page.pageId === 'number' &&
              typeof page.title === 'string' &&
              typeof page.extract === 'string' &&
              typeof page.url === 'string',
          )
          .map((page) => ({
            ...page,
            lang: typeof page.lang === 'string' ? page.lang : 'en',
            note: typeof page.note === 'string' ? page.note : '',
            savedAt: typeof page.savedAt === 'number' ? page.savedAt : Date.now(),
            contextMode: page.contextMode === 'full' ? 'full' : 'intro',
            fullText: typeof page.fullText === 'string' ? page.fullText : undefined,
            aiLang: typeof page.aiLang === 'string' ? page.aiLang : undefined,
            aiTitle: typeof page.aiTitle === 'string' ? page.aiTitle : undefined,
            aiExtract: typeof page.aiExtract === 'string' ? page.aiExtract : undefined,
            aiFullText: typeof page.aiFullText === 'string' ? page.aiFullText : undefined,
          }))
      : [],
    savedPlaces: Array.isArray(value.savedPlaces)
      ? value.savedPlaces
          .filter(
            (place) =>
              place && typeof place.name === 'string' && Number.isFinite(place.lat) && Number.isFinite(place.lng),
          )
          .map((place) => ({
            ...place,
            note: typeof place.note === 'string' ? place.note : '',
            savedAt: typeof place.savedAt === 'number' ? place.savedAt : Date.now(),
          }))
      : [],
    poiBriefs: Array.isArray(value.poiBriefs)
      ? value.poiBriefs
          .filter(
            (brief) =>
              brief && typeof brief.id === 'string' && typeof brief.name === 'string',
          )
          .map((brief) => ({
            id: brief.id,
            name: brief.name,
            nameZh: typeof brief.nameZh === 'string' ? brief.nameZh : undefined,
            category: typeof brief.category === 'string' ? brief.category : undefined,
            address: typeof brief.address === 'string' ? brief.address : undefined,
            distanceM: typeof brief.distanceM === 'number' ? brief.distanceM : undefined,
            addedAt: typeof brief.addedAt === 'number' ? brief.addedAt : Date.now(),
          }))
      : [],
    poiAllToAI: typeof value.poiAllToAI === 'boolean' ? value.poiAllToAI : false,
    view:
      value.view &&
      value.view.center &&
      Number.isFinite(value.view.center.lat) &&
      Number.isFinite(value.view.center.lng) &&
      typeof value.view.zoom === 'number' &&
      Number.isFinite(value.view.zoom)
        ? {
            center: { lat: value.view.center.lat, lng: value.view.center.lng },
            zoom: value.view.zoom,
          }
        : undefined,
    lastTab:
      value.lastTab === 'nearby' ||
      value.lastTab === 'wiki' ||
      value.lastTab === 'saved' ||
      value.lastTab === 'route'
        ? value.lastTab
        : undefined,
    lastWiki:
      value.lastWiki &&
      typeof value.lastWiki.lang === 'string' &&
      typeof value.lastWiki.title === 'string' &&
      Number.isFinite(value.lastWiki.pageId)
        ? {
            lang: value.lastWiki.lang,
            pageId: value.lastWiki.pageId,
            title: value.lastWiki.title,
            lat: typeof value.lastWiki.lat === 'number' ? value.lastWiki.lat : undefined,
            lng: typeof value.lastWiki.lng === 'number' ? value.lastWiki.lng : undefined,
          }
        : undefined,
    lastWikiMode:
      value.lastWikiMode === 'intro' || value.lastWikiMode === 'full' ? value.lastWikiMode : undefined,
    wikiOpen: typeof value.wikiOpen === 'boolean' ? value.wikiOpen : undefined,
    itinerary: validItinerary(value.itinerary),
  }
}

export function saveState(ctx: StContext, state: MapState): void {
  state.updatedAt = Date.now()
  if (!ctx.chatMetadata) return
  ctx.chatMetadata['tavern-map'] = state
  ctx.saveMetadataDebounced?.()
}
