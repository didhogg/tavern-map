import type { MapState, StContext } from './types'

export const DEFAULT_STATE: MapState = {
  version: 1,
  enabled: true,
  center: { lat: 35.6595, lng: 139.7005 },
  zoom: 14,
  nearby: [],
  wiki: [],
  stars: [],
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
          }))
      : [],
  }
}

export function saveState(ctx: StContext, state: MapState): void {
  state.updatedAt = Date.now()
  if (!ctx.chatMetadata) return
  ctx.chatMetadata['tavern-map'] = state
  ctx.saveMetadataDebounced?.()
}
