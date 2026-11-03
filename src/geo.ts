/** Great-circle distance in metres. */
export function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000
  const dLat = ((bLat - aLat) * Math.PI) / 180
  const dLng = ((bLng - aLng) * Math.PI) / 180
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

export function formatDistance(metres: number | undefined): string {
  if (metres == null || !Number.isFinite(metres)) return ''
  if (metres < 1000) return `${Math.round(metres)}m`
  return `${(metres / 1000).toFixed(1)}km`
}

/**
 * Normalise OSM ids from Photon (`osm:W/123`), Overpass (`way/123`) and
 * fallback point ids so the same physical place keeps the same key.
 */
export function placeKey(place: { id?: string; lat: number; lng: number }): string {
  const raw = place.id?.trim() ?? ''
  const osm = raw.match(/^(?:osm:)?([nwr])[/:-]?(\d+)$/i)
  if (osm) {
    const type = ({ n: 'node', w: 'way', r: 'relation' } as Record<string, string>)[osm[1].toLowerCase()]
    if (type) return `${type}/${osm[2]}`
  }
  const slash = raw.match(/^(node|way|relation)\/(\d+)$/i)
  if (slash) return `${slash[1].toLowerCase()}/${slash[2]}`
  return `${raw}|${place.lat.toFixed(4)}|${place.lng.toFixed(4)}`
}
