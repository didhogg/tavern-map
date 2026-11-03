import { haversine } from './geo'
import { errorMessage, fetchJson, fetchText } from './http'
import type { Place } from './types'

type PhotonFeature = {
  properties?: {
    osm_type?: string
    osm_id?: number
    type?: string
    name?: string
    street?: string
    locality?: string
    district?: string
    city?: string
    state?: string
    country?: string
    postcode?: string
  }
  geometry?: { coordinates?: [number, number] }
}

type PhotonResponse = { features?: PhotonFeature[] }

/** Photon public instance: CORS-enabled, OSM-based, no key. */
export async function reverseGeocode(lat: number, lng: number): Promise<Place> {
  try {
    const url = new URL('https://photon.komoot.io/reverse')
    url.searchParams.set('lat', lat.toFixed(6))
    url.searchParams.set('lon', lng.toFixed(6))
    url.searchParams.set('lang', 'en')
    const data = await fetchJson<PhotonResponse>(url)
    const feature = data.features?.[0]
    if (feature?.properties) {
      const p = feature.properties
      const address = [p.street, p.locality, p.district, p.city, p.state, p.country]
        .filter(Boolean)
        .join(', ')
      return {
        id: `osm:${p.osm_type ?? '?'}/${p.osm_id ?? '?'}`,
        name: p.name || p.street || p.city || 'Unknown place',
        category: p.type,
        address: address || undefined,
        lat,
        lng,
      }
    }
  } catch (error) {
    console.warn('[tavern-map] Photon reverse failed, falling back', error)
  }
  return reverseFallback(lat, lng)
}

type BigDataCloudResponse = {
  locality?: string
  city?: string
  principalSubdivision?: string
  countryName?: string
  postcode?: string
}

/** BigDataCloud client-side reverse geocoding: CORS-enabled, no key. */
async function reverseFallback(lat: number, lng: number): Promise<Place> {
  try {
    const url = new URL('https://api.bigdatacloud.net/data/reverse-geocode-client')
    url.searchParams.set('latitude', String(lat))
    url.searchParams.set('longitude', String(lng))
    url.searchParams.set('localityLanguage', 'en')
    const data = await fetchJson<BigDataCloudResponse>(url)
    const address = [data.locality, data.city, data.principalSubdivision, data.countryName]
      .filter(Boolean)
      .join(', ')
    return {
      id: `point:${lat.toFixed(5)},${lng.toFixed(5)}`,
      name: data.locality || data.city || 'Unknown place',
      address: address || undefined,
      lat,
      lng,
    }
  } catch (error) {
    console.warn('[tavern-map] reverse fallback failed', error)
    return {
      id: `point:${lat.toFixed(5)},${lng.toFixed(5)}`,
      name: 'Unknown place',
      lat,
      lng,
    }
  }
}

type OverpassElement = {
  type: string
  id: number
  lat?: number
  lon?: number
  center?: { lat?: number; lon?: number }
  tags?: Record<string, string>
}

type OverpassResponse = { elements?: OverpassElement[] }

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

/** The editing API is heavier than Overpass, so keep its bbox small. */
const OSM_FALLBACK_MAX_RADIUS_M = 250

const NEARBY_CACHE_TTL_MS = 5 * 60 * 1000
const nearbyCache = new Map<string, { at: number; places: Place[] }>()

/**
 * Overpass public instances are best-effort. Keep the radius small, use two
 * mirrors, then fall back to a small OSM API bbox so a blocked/overloaded
 * Overpass does not leave the nearby list empty.
 */
export async function nearbyPlaces(lat: number, lng: number, radiusM: number): Promise<Place[]> {
  const radius = Math.round(Math.min(1000, Math.max(50, radiusM)))
  const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)},${radius}`
  const cached = nearbyCache.get(cacheKey)
  if (cached && Date.now() - cached.at < NEARBY_CACHE_TTL_MS) return cached.places

  const query = `[out:json][timeout:20];(node(around:${radius},${lat},${lng})[name];way(around:${radius},${lat},${lng})[name];);out center 40;`
  const attempts = OVERPASS_ENDPOINTS.map(async (endpoint) => {
    try {
      const data = await fetchJson<OverpassResponse>(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ data: query }),
        },
        10000,
      )
      return remember(cacheKey, parseOverpass(data, lat, lng, radius).slice(0, 12))
    } catch (error) {
      console.warn(`[tavern-map] Overpass ${endpoint} failed`, errorMessage(error))
      throw error
    }
  })

  try {
    // Race mirrors so one blocked/slow instance does not hold the UI for the full timeout.
    return await Promise.any(attempts)
  } catch {
    // Every mirror failed; fall through to the OSM API.
  }

  try {
    const places = await osmNearby(lat, lng, radius)
    console.warn('[tavern-map] Overpass unavailable; OSM API fallback used')
    return remember(cacheKey, places)
  } catch (fallbackError) {
    throw new Error(`Overpass 与 OSM API 回退都不可用（${errorMessage(fallbackError)}）`)
  }
}

function remember(key: string, places: Place[]): Place[] {
  nearbyCache.set(key, { at: Date.now(), places })
  return places
}

type OsmNode = { lat: number; lng: number; tags: Record<string, string> }

async function osmNearby(lat: number, lng: number, radiusM: number): Promise<Place[]> {
  const radius = Math.min(OSM_FALLBACK_MAX_RADIUS_M, Math.max(50, radiusM))
  const dLat = radius / 111320
  const dLng = radius / (111320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)))
  const bbox = [lng - dLng, lat - dLat, lng + dLng, lat + dLat].map((value) => value.toFixed(7)).join(',')
  const xml = await fetchText(
    `https://api.openstreetmap.org/api/0.6/map?bbox=${bbox}`,
    { headers: { Accept: 'application/xml' } },
    25000,
  )
  return parseOsmXml(xml, lat, lng, radius).slice(0, 12)
}

function parseOsmXml(xml: string, lat: number, lng: number, radius: number): Place[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) throw new Error('OSM XML 解析失败')

  const nodes = new Map<string, OsmNode>()
  for (const element of Array.from(doc.getElementsByTagName('node'))) {
    const id = element.getAttribute('id')
    const nodeLat = Number(element.getAttribute('lat'))
    const nodeLng = Number(element.getAttribute('lon'))
    if (!id || !Number.isFinite(nodeLat) || !Number.isFinite(nodeLng)) continue
    nodes.set(id, { lat: nodeLat, lng: nodeLng, tags: readTags(element) })
  }

  const places: Place[] = []
  for (const [id, node] of nodes) {
    const place = placeFromTags(`node/${id}`, node.tags, node.lat, node.lng, lat, lng, radius)
    if (place) places.push(place)
  }

  for (const element of Array.from(doc.getElementsByTagName('way'))) {
    const id = element.getAttribute('id')
    if (!id) continue
    let sumLat = 0
    let sumLng = 0
    let count = 0
    for (const ref of Array.from(element.getElementsByTagName('nd'))) {
      const node = nodes.get(ref.getAttribute('ref') ?? '')
      if (!node) continue
      sumLat += node.lat
      sumLng += node.lng
      count += 1
    }
    if (count === 0) continue
    const place = placeFromTags(`way/${id}`, readTags(element), sumLat / count, sumLng / count, lat, lng, radius)
    if (place) places.push(place)
  }

  return dedupePlaces(places)
}

function parseOverpass(data: OverpassResponse, lat: number, lng: number, radius: number): Place[] {
  const places: Place[] = []
  for (const element of data.elements ?? []) {
    const point = element.center ?? element
    if (typeof point.lat !== 'number' || typeof point.lon !== 'number') continue
    const place = placeFromTags(
      `${element.type}/${element.id}`,
      element.tags ?? {},
      point.lat,
      point.lon,
      lat,
      lng,
      radius,
    )
    if (place) places.push(place)
  }
  return dedupePlaces(places)
}

function placeFromTags(
  id: string,
  tags: Record<string, string>,
  placeLat: number,
  placeLng: number,
  originLat: number,
  originLng: number,
  radius: number,
): Place | undefined {
  const name = tags['name:en'] || tags.name
  if (!name) return undefined
  const category = categoryOf(tags)
  if (!category) return undefined
  const distanceM = haversine(originLat, originLng, placeLat, placeLng)
  if (distanceM > radius) return undefined
  return {
    id,
    name,
    category,
    address: [tags['addr:street'], tags['addr:city']].filter(Boolean).join(', ') || undefined,
    lat: placeLat,
    lng: placeLng,
    distanceM,
  }
}

function categoryOf(tags: Record<string, string>): string | undefined {
  const category =
    tags.tourism || tags.historic || tags.amenity || tags.shop || tags.leisure || tags.office || tags.place
  if (category) return category
  if (tags.railway === 'station' || tags.railway === 'halt') return 'station'
  return undefined
}

function readTags(element: Element): Record<string, string> {
  const tags: Record<string, string> = {}
  for (const tag of Array.from(element.getElementsByTagName('tag'))) {
    const key = tag.getAttribute('k')
    const value = tag.getAttribute('v')
    if (key && value != null) tags[key] = value
  }
  return tags
}

function dedupePlaces(places: Place[]): Place[] {
  const seen = new Set<string>()
  return places
    .sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0))
    .filter((place) => {
      const key = `${place.name}|${place.lat.toFixed(3)}|${place.lng.toFixed(3)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}
