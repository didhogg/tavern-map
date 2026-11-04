import { haversine } from './geo'
import { fetchJson } from './http'
import type { LatLng, Place } from './types'

export type SearchResult = Place & {
  bounds?: [number, number, number, number]
  resultType?: string
  country?: string
  /** Rank within the Photon response; a weak prominence signal. */
  sourceRank?: number
}

type PhotonFeature = {
  properties?: {
    osm_type?: string
    osm_id?: number
    type?: string
    name?: string
    'name:zh'?: string
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

  const nameZh = clean(p['name:zh'])
  return {
    id: p.osm_type && p.osm_id != null ? `osm:${p.osm_type}/${p.osm_id}` : `search:${coordinates[1]},${coordinates[0]}`,
    name,
    nameZh: nameZh && nameZh !== name ? nameZh : undefined,
    category: p.type,
    address: address || undefined,
    lat: coordinates[1],
    lng: coordinates[0],
    bounds,
    resultType: p.type,
    country: clean(p.country),
  }
}

/**
 * Rank by textual relevance first, then by distance from the current place.
 * Exact name matches can still beat a nearby loose match; among equally good
 * matches, the nearest result wins.
 */
export function rankSearchResults(
  results: SearchResult[],
  query: string,
  near?: LatLng,
): SearchResult[] {
  const q = query.trim().toLowerCase()
  const tokens = q.split(/\s+/).filter((token) => token.length > 0)
  return results
    .map((result) => {
      const name = result.name.toLowerCase()
      const nameZh = (result.nameZh ?? '').toLowerCase()
      const address = (result.address ?? '').toLowerCase()
      const exact = name === q || nameZh === q
      const starts = name.startsWith(q) || nameZh.startsWith(q)
      const includes = name.includes(q) || nameZh.includes(q)
      const tokenHits = tokens.filter(
        (token) => name.includes(token) || nameZh.includes(token) || address.includes(token),
      ).length
      const type = (result.resultType ?? '').toLowerCase()
      const prominence = [
        'country',
        'state',
        'region',
        'county',
        'city',
        'town',
        'village',
        'municipality',
        'district',
        'locality',
        'borough',
        'suburb',
      ].includes(type)
        ? 35
        : [
              'attraction',
              'museum',
              'viewpoint',
              'tourism',
              'historic',
              'monument',
              'memorial',
              'castle',
              'park',
              'station',
              'airport',
              'university',
              'hospital',
            ].includes(type)
          ? 12
          : 0
      const sourceRank = result.sourceRank ?? 20
      // Tiny tie-breaker only; distance and text/type still dominate. This
      // keeps nearby branches ordered by distance while letting famous exact
      // results beat distant namesakes.
      const rankBonus = Math.max(0, 12 - sourceRank) * 0.05
      const textScore =
        (exact ? 100 : starts ? 70 : includes ? 45 : 0) +
        tokenHits * 6 +
        prominence +
        rankBonus
      const distanceM = near
        ? haversine(near.lat, near.lng, result.lat, result.lng)
        : result.distanceM
      const proximity = distanceM == null ? 0 : 45 * Math.exp(-distanceM / 25000)
      return { result: { ...result, distanceM }, score: textScore + proximity }
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.result.distanceM ?? Number.POSITIVE_INFINITY) -
          (b.result.distanceM ?? Number.POSITIVE_INFINITY),
    )
    .slice(0, 8)
    .map(({ result }) => result)
}

/** Forward geocoding through Photon (CORS-enabled, no key). */
export async function searchPlaces(query: string, near?: LatLng): Promise<SearchResult[]> {
  const q = query.trim()
  if (q.length < 2) return []

  const makeUrl = (bias: boolean): URL => {
    const url = new URL('https://photon.komoot.io/api')
    url.searchParams.set('q', q)
    url.searchParams.set('limit', '20')
    url.searchParams.set('lang', 'en')
    if (near && bias) {
      url.searchParams.set('lat', String(near.lat))
      url.searchParams.set('lon', String(near.lng))
      url.searchParams.set('location_bias_scale', '0.2')
    }
    return url
  }

  // Query both the nearby-biased and the neutral index. The neutral pass keeps
  // famous / exact results from being pushed out by a nearby namesake.
  const urls = near ? [makeUrl(true), makeUrl(false)] : [makeUrl(false)]
  const responses = await Promise.allSettled(
    urls.map((url) => fetchJson<PhotonResponse>(url, undefined, 10000)),
  )
  const features: Array<{ feature: PhotonFeature; rank: number }> = []
  for (const response of responses) {
    if (response.status !== 'fulfilled') continue
    for (const [index, feature] of (response.value.features ?? []).entries()) {
      features.push({ feature, rank: index })
    }
  }
  if (responses.every((response) => response.status === 'rejected')) {
    const first = responses[0]
    if (first.status === 'rejected') throw first.reason
  }

  const seen = new Set<string>()
  const results: SearchResult[] = []
  for (const { feature, rank } of features) {
    const result = toResult(feature)
    if (!result) continue
    const key = `${result.name}|${result.lat.toFixed(4)}|${result.lng.toFixed(4)}`
    if (seen.has(key)) continue
    seen.add(key)
    results.push({ ...result, sourceRank: rank })
  }
  return rankSearchResults(results, q, near)
}
