import type { LayerRegion } from './layer-types'

export function pointInRing(x: number, y: number, ring: Array<[number, number]>): boolean {
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [xi, yi] = ring[index]
    const [xj, yj] = ring[previous]
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

/** Regions whose polygon contains the point, smallest first (area = containing ring's box). */
export function regionsAtPoint(
  regions: LayerRegion[],
  x: number,
  y: number,
): Array<{ region: LayerRegion; area: number }> {
  const found: Array<{ region: LayerRegion; area: number }> = []
  for (const region of regions) {
    let best = Infinity
    for (const ring of region.polygons) {
      if (!pointInRing(x, y, ring)) continue
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (const [px, py] of ring) {
        minX = Math.min(minX, px)
        maxX = Math.max(maxX, px)
        minY = Math.min(minY, py)
        maxY = Math.max(maxY, py)
      }
      best = Math.min(best, Math.max(0, maxX - minX) * Math.max(0, maxY - minY))
    }
    if (best < Infinity) found.push({ region, area: best })
  }
  return found.sort((a, b) => a.area - b.area)
}

/**
 * The region and the areas around it, nearest first. A declared parent
 * (`parent_region_id` in the map data) wins; a region without one falls back
 * to the next larger region whose polygon contains the point. Names are never
 * compared.
 */
export function regionChain(
  regions: LayerRegion[],
  start: LayerRegion | undefined,
  x: number,
  y: number,
): LayerRegion[] {
  if (!start) return []
  const byId = new Map(regions.map((region) => [region.id, region]))
  const containing = regionsAtPoint(regions, x, y)
  const chain: LayerRegion[] = []
  const seen = new Set<string>()
  let current: LayerRegion | undefined = start
  while (current && !seen.has(current.id)) {
    chain.push(current)
    seen.add(current.id)
    const declared: LayerRegion | undefined = current.parentId ? byId.get(current.parentId) : undefined
    if (declared) {
      current = declared
      continue
    }
    const id: string = current.id
    const ownArea: number = containing.find((item) => item.region.id === id)?.area ?? 0
    current = containing.find((item) => !seen.has(item.region.id) && item.area > ownArea)?.region
  }
  return chain
}
