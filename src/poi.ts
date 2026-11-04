import { haversine } from './geo'
import { errorMessage, fetchJson, fetchText } from './http'
import { nearbyPlaces } from './providers'
import type { Place, RoutePoi } from './types'

export type PoiGroup = 'food' | 'shopping' | 'culture' | 'nature' | 'transit' | 'service' | 'other'

export type Poi = Place & {
  group: PoiGroup
  tags?: Record<string, string>
  openingHours?: string
  website?: string
  cuisine?: string
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

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

const MAX_POIS = 500
const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { at: number; pois: Poi[] }>()

function groupOf(tags: Record<string, string>): PoiGroup {
  const amenity = tags.amenity
  const shop = tags.shop
  const tourism = tags.tourism
  const historic = tags.historic
  const leisure = tags.leisure
  const railway = tags.railway
  const publicTransport = tags.public_transport

  if (
    ['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'biergarten', 'ice_cream', 'food_court'].includes(amenity) ||
    ['bakery', 'butcher', 'greengrocer', 'confectionery', 'deli', 'cheese', 'seafood'].includes(shop)
  ) {
    return 'food'
  }
  if (railway === 'station' || railway === 'halt' || publicTransport === 'station' || amenity === 'bus_station') {
    return 'transit'
  }
  if (tourism || historic) return 'culture'
  if (
    ['park', 'garden', 'playground', 'nature_reserve', 'common', 'pitch', 'sports_centre'].includes(leisure)
  ) {
    return 'nature'
  }
  if (shop || amenity === 'marketplace') return 'shopping'
  if (
    ['bank', 'pharmacy', 'hospital', 'clinic', 'school', 'university', 'college', 'post_office', 'parking', 'toilets', 'place_of_worship'].includes(
      amenity,
    ) ||
    tags.office ||
    tags.place
  ) {
    return 'service'
  }
  return 'other'
}

function makePoi(element: OverpassElement, originLat: number, originLng: number): Poi | null {
  const point = element.center ?? element
  if (typeof point.lat !== 'number' || typeof point.lon !== 'number') return null
  return poiFromTags(`${element.type}/${element.id}`, element.tags ?? {}, point.lat, point.lon, originLat, originLng)
}

function poiFromTags(
  id: string,
  tags: Record<string, string>,
  lat: number,
  lng: number,
  originLat: number,
  originLng: number,
): Poi | null {
  const name = tags['name:en'] || tags.name
  if (!name) return null
  const category =
    tags.tourism || tags.historic || tags.amenity || tags.shop || tags.leisure || tags.office || tags.place || tags.railway
  if (!category) return null
  const nameZh = tags['name:zh'] || tags['name:zh-Hans'] || tags['name:zh-Hant']
  return {
    id,
    name,
    nameZh: nameZh && nameZh !== name ? nameZh : undefined,
    category,
    address:
      [
        [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
        tags['addr:city'] || tags['addr:town'] || tags['addr:suburb'],
      ]
        .filter(Boolean)
        .join(', ') || undefined,
    lat,
    lng,
    distanceM: haversine(originLat, originLng, lat, lng),
    group: groupOf(tags),
    tags,
    openingHours: tags.opening_hours,
    website: tags.website || tags['contact:website'],
    cuisine: tags.cuisine,
  }
}

function groupFromCategory(category: string | undefined): PoiGroup {
  const value = (category ?? '').toLowerCase()
  if (
    ['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'bakery', 'confectionery', 'food_court', 'ice_cream'].includes(
      value,
    )
  ) {
    return 'food'
  }
  if (['station', 'halt', 'bus_station', 'public_transport'].includes(value)) return 'transit'
  if (
    ['attraction', 'museum', 'viewpoint', 'artwork', 'information', 'monument', 'memorial', 'castle', 'gallery'].includes(
      value,
    )
  ) {
    return 'culture'
  }
  if (
    ['park', 'garden', 'playground', 'nature_reserve', 'common', 'pitch', 'sports_centre'].includes(value)
  ) {
    return 'nature'
  }
  if (
    ['supermarket', 'convenience', 'clothes', 'books', 'department_store', 'mall', 'marketplace'].includes(value)
  ) {
    return 'shopping'
  }
  return 'service'
}

function dedupe(pois: Poi[]): Poi[] {
  const seen = new Set<string>()
  return pois
    .sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0))
    .filter((poi) => {
      const key = `${poi.name}|${poi.lat.toFixed(3)}|${poi.lng.toFixed(3)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
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

async function osmFallback(lat: number, lng: number, radiusM: number): Promise<Poi[]> {
  const radius = Math.min(250, Math.max(50, radiusM))
  const dLat = radius / 111320
  const dLng = radius / (111320 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)))
  const bbox = [lng - dLng, lat - dLat, lng + dLng, lat + dLat].map((value) => value.toFixed(7)).join(',')
  const xml = await fetchText(
    `https://api.openstreetmap.org/api/0.6/map?bbox=${bbox}`,
    { headers: { Accept: 'application/xml' } },
    25000,
  )
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) throw new Error('OSM XML 解析失败')

  const nodes = new Map<string, { lat: number; lng: number; tags: Record<string, string> }>()
  for (const element of Array.from(doc.getElementsByTagName('node'))) {
    const id = element.getAttribute('id')
    const nodeLat = Number(element.getAttribute('lat'))
    const nodeLng = Number(element.getAttribute('lon'))
    if (!id || !Number.isFinite(nodeLat) || !Number.isFinite(nodeLng)) continue
    nodes.set(id, { lat: nodeLat, lng: nodeLng, tags: readTags(element) })
  }

  const pois: Poi[] = []
  for (const [id, node] of nodes) {
    const poi = poiFromTags(`node/${id}`, node.tags, node.lat, node.lng, lat, lng)
    if (poi) pois.push(poi)
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
    const poi = poiFromTags(
      `way/${id}`,
      readTags(element),
      sumLat / count,
      sumLng / count,
      lat,
      lng,
    )
    if (poi) pois.push(poi)
  }
  return dedupe(pois).slice(0, MAX_POIS)
}

/** Interactive POI layer around the current centre, with a small nearby fallback. */
export async function fetchPois(lat: number, lng: number, radiusM: number): Promise<Poi[]> {
  const radius = Math.round(Math.min(1000, Math.max(50, radiusM)))
  const key = `${lat.toFixed(4)},${lng.toFixed(4)},${radius}`
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.pois

  const around = `around:${radius},${lat},${lng}`
  const query = `[out:json][timeout:20];(
    nwr(${around})[name][tourism];
    nwr(${around})[name][historic];
    nwr(${around})[name][amenity];
    nwr(${around})[name][shop];
    nwr(${around})[name][leisure];
    nwr(${around})[name][office];
    nwr(${around})[name][place];
    nwr(${around})[name][railway];
    nwr(${around})[name][public_transport];
  );out center ${MAX_POIS};`

  const overpass = Promise.any(
    ENDPOINTS.map(async (endpoint) => {
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
        const pois = dedupe(
          (data.elements ?? [])
            .map((element) => makePoi(element, lat, lng))
            .filter((poi): poi is Poi => Boolean(poi)),
        ).slice(0, MAX_POIS)
        if (pois.length === 0) throw new Error('Overpass 返回空结果')
        return pois
      } catch (error) {
        console.warn('[tavern-map] POI Overpass failed', endpoint, errorMessage(error))
        throw error
      }
    }),
  )

  let fallbackTimer: number | undefined
  const osm = new Promise<Poi[]>((resolve, reject) => {
    fallbackTimer = window.setTimeout(() => {
      osmFallback(lat, lng, radius).then(
        (pois) => {
          if (pois.length === 0) reject(new Error('OSM API 返回空结果'))
          else {
            console.warn('[tavern-map] POI OSM API fallback used')
            resolve(pois)
          }
        },
        (error) => {
          console.warn('[tavern-map] POI OSM API fallback failed', errorMessage(error))
          reject(error)
        },
      )
    }, 1500)
  })

  try {
    const pois = await Promise.any([overpass, osm])
    if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer)
    cache.set(key, { at: Date.now(), pois })
    return pois
  } catch (error) {
    if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer)
    console.warn('[tavern-map] POI sources exhausted', errorMessage(error))
  }

  const fallback = await nearbyPlaces(lat, lng, radius)
  const pois = fallback.slice(0, 24).map(
    (place): Poi => ({
      ...place,
      group: groupFromCategory(place.category),
    }),
  )
  cache.set(key, { at: Date.now(), pois })
  return pois
}

function sampleRoute(
  coordinates: Array<[number, number]>,
  spacing = 900,
  maxPoints = 18,
): Array<{ lat: number; lng: number }> {
  if (coordinates.length === 0) return []
  const points: Array<{ lat: number; lng: number }> = []
  const first = coordinates[0]
  points.push({ lat: first[1], lng: first[0] })
  let accumulated = 0
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1]
    const current = coordinates[index]
    accumulated += haversine(previous[1], previous[0], current[1], current[0])
    if (accumulated >= spacing && points.length < maxPoints) {
      points.push({ lat: current[1], lng: current[0] })
      accumulated = 0
    }
  }
  const last = coordinates[coordinates.length - 1]
  const lastPoint = points[points.length - 1]
  if (!lastPoint || haversine(lastPoint.lat, lastPoint.lng, last[1], last[0]) > 30) {
    points.push({ lat: last[1], lng: last[0] })
  }
  return points.slice(0, maxPoints)
}

/** Named POIs within a ~120m corridor of a planned route. */
export async function fetchRoutePois(
  coordinates: Array<[number, number]>,
  radiusM = 100,
): Promise<RoutePoi[]> {
  const corridor = Math.max(25, Math.min(500, radiusM))
  const points = sampleRoute(coordinates)
  if (points.length === 0) return []
  const clauses = points
    .map((point) => `nwr(around:${corridor},${point.lat.toFixed(6)},${point.lng.toFixed(6)})[name];`)
    .join('\n')
  const query = `[out:json][timeout:20];\n(\n${clauses}\n);\nout center 300;`
  const request = (endpoint: string) =>
    fetchJson<OverpassResponse>(
      endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }),
      },
      15000,
    )

  try {
    const data = await Promise.any(ENDPOINTS.map((endpoint) => request(endpoint)))
    const origin = points[0]
    const pois = dedupe(
      (data.elements ?? [])
        .map((element) => makePoi(element, origin.lat, origin.lng))
        .filter((poi): poi is Poi => Boolean(poi)),
    )
    if (pois.length > 0) {
      return pois.slice(0, 50).map((poi) => ({
        id: poi.id,
        name: poi.name,
        nameZh: poi.nameZh,
        category: poi.category,
        address: poi.address,
        lat: poi.lat,
        lng: poi.lng,
        distanceM: poi.distanceM,
        cuisine: poi.cuisine,
        openingHours: poi.openingHours,
      }))
    }
  } catch (error) {
    console.warn('[tavern-map] route POI lookup failed', errorMessage(error))
  }
  return routeOsmFallback(coordinates, corridor)
}

/** Fallback when Overpass is unavailable: filter already-loaded POIs by route corridor. */
export function filterPoisAlongRoute(
  coordinates: Array<[number, number]>,
  candidates: Poi[],
  radiusM = 100,
): RoutePoi[] {
  if (coordinates.length === 0 || candidates.length === 0) return []
  const start = coordinates[0]
  const results: Array<{ poi: Poi; order: number }> = []
  for (const poi of candidates) {
    let nearest = Number.POSITIVE_INFINITY
    let order = 0
    for (let index = 0; index < coordinates.length; index += 1) {
      const [lng, lat] = coordinates[index]
      const distance = haversine(poi.lat, poi.lng, lat, lng)
      if (distance < nearest) {
        nearest = distance
        order = index
      }
    }
    if (nearest <= Math.max(25, Math.min(500, radiusM))) results.push({ poi, order })
  }
  return results
    .sort((a, b) => a.order - b.order)
    .slice(0, 50)
    .map(({ poi }) => ({
      id: poi.id,
      name: poi.name,
      nameZh: poi.nameZh,
      category: poi.category,
      address: poi.address,
      lat: poi.lat,
      lng: poi.lng,
      distanceM: haversine(start[1], start[0], poi.lat, poi.lng),
      cuisine: poi.cuisine,
      openingHours: poi.openingHours,
    }))
}

async function routeOsmFallback(
  coordinates: Array<[number, number]>,
  radiusM: number,
): Promise<RoutePoi[]> {
  const points = sampleRoute(coordinates, 1600, 6)
  const candidates: Poi[] = []
  for (const point of points) {
    try {
      candidates.push(...(await osmFallback(point.lat, point.lng, 250)))
    } catch (error) {
      console.warn('[tavern-map] route OSM fallback sample failed', errorMessage(error))
    }
  }
  return filterPoisAlongRoute(coordinates, candidates, radiusM)
}

/**
 * Attach each POI to the nearest route leg. `distanceM` becomes the distance
 * from that leg, while `alongM` is the distance from the leg's start.
 */
export function assignRoutePoisToSteps(
  steps: Array<{ coordinates?: Array<[number, number]> }>,
  pois: RoutePoi[],
  radiusM: number,
): RoutePoi[][] {
  const result: RoutePoi[][] = steps.map(() => [])
  const corridor = Math.max(25, Math.min(500, radiusM))
  for (const poi of pois) {
    let bestStep = -1
    let bestDistance = Number.POSITIVE_INFINITY
    let bestAlong = 0
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      const coordinates = steps[stepIndex].coordinates
      if (!coordinates || coordinates.length < 2) continue
      let along = 0
      for (let index = 0; index < coordinates.length; index += 1) {
        if (index > 0) {
          const previous = coordinates[index - 1]
          const current = coordinates[index]
          along += haversine(previous[1], previous[0], current[1], current[0])
        }
        const [lng, lat] = coordinates[index]
        const distance = haversine(poi.lat, poi.lng, lat, lng)
        if (distance < bestDistance) {
          bestDistance = distance
          bestStep = stepIndex
          bestAlong = along
        }
      }
    }
    if (bestStep >= 0 && bestDistance <= corridor) {
      result[bestStep].push({
        ...poi,
        distanceM: bestDistance,
        alongM: bestAlong,
      })
    }
  }
  return result.map((items) => items.sort((a, b) => (a.alongM ?? 0) - (b.alongM ?? 0)))
}
