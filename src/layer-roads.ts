import type { LayerStreet } from './layer-types'

/**
 * Road lines of a map package: importance rank and a spatial index that finds
 * the road nearest to a point without scanning every segment.
 *
 * Coordinates are the package's normalized [x, y]. `yScale` stretches Y so
 * distances are measured in the same unit on both axes (image maps).
 */

/** 0 = main road, 1 = secondary, 2 = minor street / path. */
export function roadRank(type: string | undefined): number {
  const value = (type ?? '').trim().toLowerCase()
  if (!value) return 2
  if (/^(main|motorway|trunk|primary|highway|major[ _-]?road|road)(_link)?$/.test(value)) return 0
  if (/^(major|secondary|tertiary)(_link)?$/.test(value)) return 1
  return 2
}

export type RoadBounds = { minX: number; minY: number; maxX: number; maxY: number }

export type RoadIndex = {
  streets: LayerStreet[]
  /** Bounds of each street, same order as `streets`. */
  bounds: RoadBounds[]
  yScale: number
  origin: { x: number; y: number }
  cell: number
  columns: number
  rows: number
  /** Bucket key -> list of [streetIndex, segmentIndex]. */
  buckets: Map<number, Array<[number, number]>>
}

const TARGET_BUCKETS_PER_SIDE = 96

export function buildRoadIndex(streets: LayerStreet[], yScale = 1): RoadIndex {
  const bounds: RoadBounds[] = []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const street of streets) {
    const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    for (const [x, y] of street.points) {
      box.minX = Math.min(box.minX, x)
      box.maxX = Math.max(box.maxX, x)
      box.minY = Math.min(box.minY, y * yScale)
      box.maxY = Math.max(box.maxY, y * yScale)
    }
    bounds.push(box)
    minX = Math.min(minX, box.minX)
    minY = Math.min(minY, box.minY)
    maxX = Math.max(maxX, box.maxX)
    maxY = Math.max(maxY, box.maxY)
  }
  const span = Math.max(maxX - minX, maxY - minY)
  const cell = Number.isFinite(span) && span > 0 ? span / TARGET_BUCKETS_PER_SIDE : 1
  const origin = { x: Number.isFinite(minX) ? minX : 0, y: Number.isFinite(minY) ? minY : 0 }
  const columns = Number.isFinite(span) ? Math.max(1, Math.ceil((maxX - origin.x) / cell) + 1) : 1
  const rows = Number.isFinite(span) ? Math.max(1, Math.ceil((maxY - origin.y) / cell) + 1) : 1
  const buckets = new Map<number, Array<[number, number]>>()
  streets.forEach((street, streetIndex) => {
    for (let index = 1; index < street.points.length; index += 1) {
      const [x1, y1] = street.points[index - 1]
      const [x2, y2] = street.points[index]
      const c1 = Math.floor((Math.min(x1, x2) - origin.x) / cell)
      const c2 = Math.floor((Math.max(x1, x2) - origin.x) / cell)
      const r1 = Math.floor((Math.min(y1, y2) * yScale - origin.y) / cell)
      const r2 = Math.floor((Math.max(y1, y2) * yScale - origin.y) / cell)
      for (let column = c1; column <= c2; column += 1) {
        for (let row = r1; row <= r2; row += 1) {
          const key = row * columns + column
          let list = buckets.get(key)
          if (!list) buckets.set(key, (list = []))
          list.push([streetIndex, index])
        }
      }
    }
  })
  return { streets, bounds, yScale, origin, cell, columns, rows, buckets }
}

export type NearestRoad = {
  street: LayerStreet
  /** Distance in normalized X units (Y scaled by yScale). */
  distance: number
  /** Closest point on the road, normalized (unscaled) coordinates. */
  x: number
  y: number
}

/** A point on one road segment: street, segment (index of its end vertex) and position. */
export type RoadHit = {
  streetIndex: number
  /** Index of the segment's end vertex in `street.points` (start is segment - 1). */
  segment: number
  /** 0..1 along the segment. */
  t: number
  /** Distance in normalized X units (Y scaled by yScale). */
  distance: number
  /** Closest point, normalized (unscaled) coordinates. */
  x: number
  y: number
}

/** Visit every segment hit within `maxDistance` of (x, y) (a segment may be visited twice). */
function scanSegments(
  index: RoadIndex,
  x: number,
  y: number,
  maxDistance: number,
  visit: (hit: RoadHit) => void,
): void {
  if (!index.streets.length || !(maxDistance > 0)) return
  const py = y * index.yScale
  const c1 = Math.max(0, Math.floor((x - maxDistance - index.origin.x) / index.cell))
  const c2 = Math.min(index.columns - 1, Math.floor((x + maxDistance - index.origin.x) / index.cell))
  const r1 = Math.max(0, Math.floor((py - maxDistance - index.origin.y) / index.cell))
  const r2 = Math.min(index.rows - 1, Math.floor((py + maxDistance - index.origin.y) / index.cell))
  for (let column = c1; column <= c2; column += 1) {
    for (let row = r1; row <= r2; row += 1) {
      for (const [streetIndex, segment] of index.buckets.get(row * index.columns + column) ?? []) {
        const street = index.streets[streetIndex]
        const [ax, ay] = street.points[segment - 1]
        const [bx, by] = street.points[segment]
        const sy1 = ay * index.yScale
        const sy2 = by * index.yScale
        const dx = bx - ax
        const dy = sy2 - sy1
        const length = dx * dx + dy * dy
        const t = length > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (py - sy1) * dy) / length)) : 0
        const cx = ax + dx * t
        const cy = sy1 + dy * t
        const distance = Math.hypot(x - cx, py - cy)
        if (distance <= maxDistance) {
          visit({ streetIndex, segment, t, distance, x: cx, y: cy / index.yScale })
        }
      }
    }
  }
}

/** The closest road segment to (x, y) within `maxDistance`; `skip` excludes a street. */
export function nearestSegment(
  index: RoadIndex,
  x: number,
  y: number,
  maxDistance: number,
  skip?: (streetIndex: number) => boolean,
): RoadHit | undefined {
  let best: RoadHit | undefined
  scanSegments(index, x, y, maxDistance, (hit) => {
    if (skip?.(hit.streetIndex)) return
    if (!best || hit.distance < best.distance) best = hit
  })
  return best
}

/** The road closest to (x, y) within `maxDistance`, or undefined. */
export function nearestRoad(
  index: RoadIndex,
  x: number,
  y: number,
  maxDistance: number,
): NearestRoad | undefined {
  const hit = nearestSegment(index, x, y, maxDistance)
  return hit
    ? { street: index.streets[hit.streetIndex], distance: hit.distance, x: hit.x, y: hit.y }
    : undefined
}

/** Every street within `maxDistance` of the point, with its own closest point, nearest first. */
export function roadsNearPoint(
  index: RoadIndex,
  x: number,
  y: number,
  maxDistance: number,
): RoadHit[] {
  const best = new Map<number, RoadHit>()
  scanSegments(index, x, y, maxDistance, (hit) => {
    const current = best.get(hit.streetIndex)
    if (!current || hit.distance < current.distance) best.set(hit.streetIndex, hit)
  })
  return [...best.values()].sort((a, b) => a.distance - b.distance)
}

/** Indices of streets whose bounds overlap the given (scaled) rectangle. */
export function roadsInRect(index: RoadIndex, rect: RoadBounds): number[] {
  const result: number[] = []
  index.bounds.forEach((box, streetIndex) => {
    if (box.maxX >= rect.minX && box.minX <= rect.maxX && box.maxY >= rect.minY && box.minY <= rect.maxY) {
      result.push(streetIndex)
    }
  })
  return result
}
