/**
 * Polyline measuring for itinerary legs (straight or following roads).
 * Points are normalized map coordinates; `yScale` stretches Y so both axes
 * use the same unit (image maps), matching the road index.
 */
export type Pt = { x: number; y: number }

export function pointDistance(a: Pt, b: Pt, yScale = 1): number {
  return Math.hypot(b.x - a.x, (b.y - a.y) * yScale)
}

/** Cumulative length at each vertex; the last entry is the total length. */
export function polylineCumulative(points: Pt[], yScale = 1): number[] {
  const result = [0]
  for (let index = 1; index < points.length; index += 1) {
    result.push(result[index - 1] + pointDistance(points[index - 1], points[index], yScale))
  }
  return result
}

export type PolylineProjection = {
  point: Pt
  /** Length along the polyline from its first point. */
  along: number
  /** Distance from the input point to the polyline. */
  distance: number
}

export function projectOnPolyline(
  point: Pt,
  points: Pt[],
  cumulative: number[],
  yScale = 1,
): PolylineProjection {
  if (points.length === 0) return { point, along: 0, distance: 0 }
  if (points.length === 1) {
    return { point: points[0], along: 0, distance: pointDistance(point, points[0], yScale) }
  }
  let best: PolylineProjection | undefined
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]
    const b = points[index]
    const dx = b.x - a.x
    const dy = (b.y - a.y) * yScale
    const lengthSquared = dx * dx + dy * dy
    const t =
      lengthSquared <= 1e-24
        ? 0
        : Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * yScale * dy) / lengthSquared))
    const projected = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    const distance = pointDistance(point, projected, yScale)
    if (!best || distance < best.distance) {
      best = {
        point: projected,
        along: cumulative[index - 1] + (cumulative[index] - cumulative[index - 1]) * t,
        distance,
      }
    }
  }
  return best!
}

/** The point at a given length along the polyline. */
export function pointAlong(points: Pt[], cumulative: number[], along: number): Pt {
  if (points.length === 0) return { x: 0, y: 0 }
  if (along <= 0) return points[0]
  for (let index = 1; index < points.length; index += 1) {
    if (cumulative[index] >= along) {
      const span = cumulative[index] - cumulative[index - 1]
      const t = span > 0 ? (along - cumulative[index - 1]) / span : 0
      const a = points[index - 1]
      const b = points[index]
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }
  }
  return points[points.length - 1]
}

/** The part of the polyline between two lengths along it. */
export function polylineSlice(points: Pt[], cumulative: number[], from: number, to: number): Pt[] {
  if (points.length < 2) return points.slice()
  const start = Math.max(0, Math.min(from, to))
  const end = Math.min(cumulative[cumulative.length - 1], Math.max(from, to))
  const result = [pointAlong(points, cumulative, start)]
  for (let index = 1; index < points.length - 1; index += 1) {
    if (cumulative[index] > start && cumulative[index] < end) result.push(points[index])
  }
  result.push(pointAlong(points, cumulative, end))
  return result
}

function segmentPointDistance(p: Pt, a: Pt, b: Pt, yScale: number): number {
  const dx = b.x - a.x
  const dy = (b.y - a.y) * yScale
  const lengthSquared = dx * dx + dy * dy
  const t =
    lengthSquared <= 1e-24
      ? 0
      : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * yScale * dy) / lengthSquared))
  return Math.hypot(p.x - (a.x + dx * t), (p.y - a.y) * yScale - dy * t)
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const cross = (o: Pt, p: Pt, q: Pt): number => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x)
  const d1 = cross(c, d, a)
  const d2 = cross(c, d, b)
  const d3 = cross(a, b, c)
  const d4 = cross(a, b, d)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

/** Shortest distance between two segments (0 when they cross). */
export function segmentDistance(a: Pt, b: Pt, c: Pt, d: Pt, yScale = 1): number {
  if (segmentsCross(a, b, c, d)) return 0
  return Math.min(
    segmentPointDistance(a, c, d, yScale),
    segmentPointDistance(b, c, d, yScale),
    segmentPointDistance(c, a, b, yScale),
    segmentPointDistance(d, a, b, yScale),
  )
}
