import { haversine, placeKey } from './geo'
import { globalNote, setGlobalNote } from './notes-store'
import type { MapState, Place, RealPlacePart, Settings } from './types'

export function realNote(place: Place): string {
  return globalNote(`place:${placeKey(place)}`) ?? ''
}

export function realSource(place: Place): string {
  return globalNote(`real-source:${placeKey(place)}`) ?? [
    place.address,
    place.cuisine ? `菜系：${place.cuisine}` : '',
    place.openingHours ? `营业时间：${place.openingHours}` : '',
    place.tags?.description,
  ].filter(Boolean).join('\n')
}

export function realWiki(place: Place): string {
  return globalNote(`real-wiki:${placeKey(place)}`) ?? ''
}

export function realPartAllowed(place: Place, part: RealPlacePart): boolean {
  return globalNote(`real-ai:${part}:${placeKey(place)}`) !== 'off'
}

export function setRealPart(place: Place, part: RealPlacePart, checked: boolean): void {
  setGlobalNote(`real-ai:${part}:${placeKey(place)}`, checked ? '' : 'off')
}

export function realLinks(place: Place): string[] {
  const defaults = [place.website, place.tags?.website]
  const wikipedia = place.tags?.wikipedia?.match(/^([a-z-]+):(.+)$/i)
  if (wikipedia) defaults.push(`https://${wikipedia[1]}.wikipedia.org/wiki/${encodeURIComponent(wikipedia[2].replaceAll(' ', '_'))}`)
  const osm = placeKey(place).match(/^(node|way|relation)\/(\d+)$/)
  if (osm) defaults.push(`https://www.openstreetmap.org/${osm[1]}/${osm[2]}`)
  const added = globalNote(`real-links:${placeKey(place)}`)?.split(/\n+/) ?? []
  return [...new Set([...defaults, ...added].filter((url): url is string => Boolean(url) && /^https?:\/\//i.test(url!)))]
}

export function nearbyPlacesInRange(state: MapState, settings: Settings, candidates: Place[]): Place[] {
  if (state.positionCleared) return []
  const current = state.place ? placeKey(state.place) : undefined
  const unique = new Map<string, Place>()
  for (const place of candidates) {
    const key = placeKey(place)
    if (key === current || unique.has(key)) continue
    const distanceM = haversine(state.center.lat, state.center.lng, place.lat, place.lng)
    if (distanceM <= settings.radiusM) unique.set(key, { ...place, distanceM })
  }
  return [...unique.values()].sort((a, b) => a.distanceM! - b.distanceM!)
}
