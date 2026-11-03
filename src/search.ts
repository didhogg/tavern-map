import { fetchJson } from './http'
import type { Place } from './types'

export type SearchResult = Place & {
  bounds?: [number, number, number, number]
  resultType?: string
  country?: string
}

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
    county?: string
    state?: string
    country?: string
    postcode?: string
    extent?: number[]
  }
  geometry?: { coordinates?: [number, number] }
}

type PhotonResponse = { features?: PhotonFeature[] }

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function toResult(feature: PhotonFeature): SearchResult | null {
  const p = feature.properties
  const coordinates = feature.geometry?.coordinates
  if (!p || !coordinates || !Number.isFinite(coordinates[0]) || !Number.isFinite(coordinates[1])) return null

  const name = clean(p.name) ?? clean(p.street) ?? clean(p.city) ?? clean(p.country)
  if (!name) return null

  const parts = [
    clean(p.street),
    clean(p.locality),
    clean(p.district),
    clean(p.city),
    clean(p.county),
    clean(p.state),
    clean(p.country),
  ].filter((part): part is string => Boolean(part))
  const address = Array.from(new Set(parts)).join(', ')

  const extent = p.extent
  const bounds =
    Array.isArray(extent) &&
    extent.length === 4 &&
    extent.every((value) => Number.isFinite(value)) &&
    extent[0] < extent[2] &&
    extent[1] < extent[3]
      ? ([extent[0], extent[1], extent[2], extent[3]] as [number, number, number, number])
      : undefined

  return {
    id: p.osm_type && p.osm_id != null ? `osm:${p.osm_type}/${p.osm_id}` : `search:${coordinates[1]},${coordinates[0]}`,
    name,
    category: p.type,
    address: address || undefined,
    lat: coordinates[1],
    lng: coordinates[0],
    bounds,
    resultType: p.type,
    country: clean(p.country),
  }
}

/** Forward geocoding through Photon (CORS-enabled, no key). */
export async function searchPlaces(query: string): Promise<SearchResult[]> {
  const q = query.trim()
  if (q.length < 2) return []

  const url = new URL('https://photon.komoot.io/api')
  url.searchParams.set('q', q)
  url.searchParams.set('limit', '8')
  url.searchParams.set('lang', 'en')
  const data = await fetchJson<PhotonResponse>(url, undefined, 10000)

  const seen = new Set<string>()
  const results: SearchResult[] = []
  for (const feature of data.features ?? []) {
    const result = toResult(feature)
    if (!result) continue
    const key = `${result.name}|${result.lat.toFixed(4)}|${result.lng.toFixed(4)}`
    if (seen.has(key)) continue
    seen.add(key)
    results.push(result)
  }
  return results.slice(0, 8)
}
