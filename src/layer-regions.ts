import { segmentDistance, type Pt } from './layer-polyline'
import type { LayerRegion } from './layer-types'

type Ring = LayerRegion['polygons'][number]
type Bounds = { minX: number; minY: number; maxX: number; maxY: number }
type BoundedRing = { points: Ring; bounds: Bounds; area: number }
type Side = 'inside' | 'outside' | 'boundary'

const BOUNDARY_EPSILON = 1e-12

function ringBounds(ring: Ring): Bounds {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of ring) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  return { minX, minY, maxX, maxY }
}

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

function declaredParent(region: LayerRegion, byId: Map<string, LayerRegion>): LayerRegion | undefined {
  const id = region.parentId
  // Older Map Genie packages stored the source ID in parentId.
  const parent = id ? byId.get(id) ?? byId.get(`mapgenie-region:${id}`) : undefined
  return parent === region ? undefined : parent
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
      const { minX, minY, maxX, maxY } = ringBounds(ring)
      best = Math.min(best, Math.max(0, maxX - minX) * Math.max(0, maxY - minY))
    }
    if (best < Infinity) found.push({ region, area: best })
  }
  return found.sort((a, b) => a.area - b.area)
}

/** Regions intersecting a route or its POI range, in map X units. */
export function regionsNearPolyline(
  regions: LayerRegion[],
  points: Pt[],
  radius: number,
  yScale = 1,
): LayerRegion[] {
  const first = points[0]
  if (!first) return []
  const limit = radius + 1e-12
  const dy = limit / yScale
  const segments = points.map((b, index) => {
    const a = points[index - 1] ?? b
    return {
      a,
      b,
      minX: Math.min(a.x, b.x) - limit,
      minY: Math.min(a.y, b.y) - dy,
      maxX: Math.max(a.x, b.x) + limit,
      maxY: Math.max(a.y, b.y) + dy,
    }
  })
  return regions.filter((region) =>
    region.polygons.some((ring) => {
      // If the route starts outside the polygon, entering it requires crossing an edge.
      if (pointInRing(first.x, first.y, ring)) return true
      const bounds = ringBounds(ring)
      const candidates = segments.filter((box) =>
        box.minX <= bounds.maxX && box.maxX >= bounds.minX &&
        box.minY <= bounds.maxY && box.maxY >= bounds.minY,
      )
      if (candidates.length === 0) return false
      const vertices = ring.map(([x, y]) => ({ x, y }))
      return vertices.some((d, index) => {
        const c = vertices[index - 1] ?? vertices[vertices.length - 1]
        const minX = Math.min(c.x, d.x)
        const minY = Math.min(c.y, d.y)
        const maxX = Math.max(c.x, d.x)
        const maxY = Math.max(c.y, d.y)
        return candidates.some((box) =>
          box.minX <= maxX && box.maxX >= minX && box.minY <= maxY && box.maxY >= minY &&
          segmentDistance(box.a, box.b, c, d, yScale) <= limit,
        )
      })
    }),
  )
}

function boundsCover(outer: Bounds, inner: Bounds): boolean {
  return outer.minX <= inner.minX && outer.maxX >= inner.maxX &&
    outer.minY <= inner.minY && outer.maxY >= inner.maxY
}

function ringSide(x: number, y: number, ring: BoundedRing): Side {
  const { points, bounds } = ring
  if (x < bounds.minX - BOUNDARY_EPSILON || x > bounds.maxX + BOUNDARY_EPSILON ||
      y < bounds.minY - BOUNDARY_EPSILON || y > bounds.maxY + BOUNDARY_EPSILON) return 'outside'
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    const [ax, ay] = points[previous]
    const [bx, by] = points[index]
    if (x < Math.min(ax, bx) - BOUNDARY_EPSILON || x > Math.max(ax, bx) + BOUNDARY_EPSILON ||
        y < Math.min(ay, by) - BOUNDARY_EPSILON || y > Math.max(ay, by) + BOUNDARY_EPSILON) continue
    const scale = Math.abs(bx - ax) + Math.abs(by - ay)
    if (Math.abs((x - ax) * (by - ay) - (y - ay) * (bx - ax)) <= BOUNDARY_EPSILON * scale) return 'boundary'
  }
  return pointInRing(x, y, points) ? 'inside' : 'outside'
}

/** Split a route segment wherever it meets an area edge, then examine the spans between edges. */
function* segmentSides(a: Pt, b: Pt, rings: BoundedRing[]): Generator<Side> {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= BOUNDARY_EPSILON ** 2) return
  const candidates = rings.filter(({ bounds }) =>
    bounds.minX <= Math.max(a.x, b.x) && bounds.maxX >= Math.min(a.x, b.x) &&
    bounds.minY <= Math.max(a.y, b.y) && bounds.maxY >= Math.min(a.y, b.y),
  )
  const cuts = [0, 1]
  const cut = (t: number): void => { if (t > 0 && t < 1) cuts.push(t) }
  for (const { points } of candidates) {
    for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
      const [x, y] = points[previous]
      const [endX, endY] = points[index]
      const ex = endX - x
      const ey = endY - y
      const px = x - a.x
      const py = y - a.y
      const divisor = dx * ey - dy * ex
      if (divisor === 0) {
        if (Math.abs(px * dy - py * dx) <= BOUNDARY_EPSILON * Math.sqrt(lengthSquared)) {
          cut((px * dx + py * dy) / lengthSquared)
          cut(((endX - a.x) * dx + (endY - a.y) * dy) / lengthSquared)
        }
        continue
      }
      const edgeFraction = (px * dy - py * dx) / divisor
      if (edgeFraction >= -BOUNDARY_EPSILON && edgeFraction <= 1 + BOUNDARY_EPSILON) {
        cut((px * ey - py * ex) / divisor)
      }
    }
  }
  cuts.sort((left, right) => left - right)
  for (let index = 1; index < cuts.length; index += 1) {
    const from = cuts[index - 1]
    const to = cuts[index]
    if ((to - from) ** 2 * lengthSquared <= BOUNDARY_EPSILON ** 2) continue
    const middle = (from + to) / 2
    let side: Side = 'outside'
    for (const ring of candidates) {
      const location = ringSide(a.x + middle * dx, a.y + middle * dy, ring)
      if (location === 'inside') {
        side = location
        break
      }
      if (location === 'boundary') side = location
    }
    yield side
  }
}

function parentsOf(regions: LayerRegion[], shapes: Map<LayerRegion, BoundedRing[]>): Set<LayerRegion> {
  const byId = new Map(regions.map((region) => [region.id, region]))
  const parents = new Set<LayerRegion>()
  for (const [child, rings] of shapes) {
    const declared = declaredParent(child, byId)
    if (declared) {
      parents.add(declared)
      continue
    }
    // Maps without parent IDs can still contain nested areas. Require containment
    // of each child polygon so neighboring or partly overlapping areas stay peers.
    if (!rings.length) continue
    let parent: LayerRegion | undefined
    let bestArea = Infinity
    for (const [candidate, outerRings] of shapes) {
      if (candidate === child) continue
      const area = outerRings.reduce((sum, ring) => sum + ring.area, 0)
      if (area >= bestArea) continue
      if (rings.every((inner) => outerRings.some((outer) =>
        outer.area > inner.area && boundsCover(outer.bounds, inner.bounds) &&
        inner.points.every(([x, y], index) => {
          const [prevX, prevY] = inner.points[index - 1] ?? inner.points[inner.points.length - 1]
          return [...segmentSides({ x: prevX, y: prevY }, { x, y }, [outer])]
            .every((side) => side !== 'outside')
        }),
      ))) {
        parent = candidate
        bestArea = area
      }
    }
    if (parent) parents.add(parent)
  }
  return parents
}

/** Leaves use the POI range. Parents only appear on legs that enter or leave their interior. */
export function itineraryRegions(regions: LayerRegion[], legs: Pt[][], radius: number, yScale = 1): LayerRegion[][] {
  const shapes = new Map(regions.map((region) => [region, region.polygons.map((points) => {
    const bounds = ringBounds(points)
    const area = (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY)
    return { points, bounds, area }
  })] as const))
  const parents = parentsOf(regions, shapes)
  const crossings = legs.map(() => new Set<LayerRegion>())
  for (const parent of parents) {
    const rings = shapes.get(parent) ?? []
    let previous: Side | undefined
    for (const [legIndex, points] of legs.entries()) {
      for (let index = 1; index < points.length; index += 1) {
        for (const side of segmentSides(points[index - 1], points[index], rings)) {
          if (side === 'boundary') continue
          if (previous && previous !== side) crossings[legIndex].add(parent)
          previous = side
        }
      }
    }
  }
  const leaves = regions.filter((region) => !parents.has(region))
  return legs.map((points, legIndex) => {
    const nearby = new Set(regionsNearPolyline(leaves, points, radius, yScale))
    return regions.filter((region) => crossings[legIndex].has(region) || nearby.has(region))
  })
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
    const declared = declaredParent(current, byId)
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
