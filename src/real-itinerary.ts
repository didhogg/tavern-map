import { haversine } from './geo'
import type { LegMode, RealRouteDraft, RealStop, RouteItinerary, RoutePoint } from './types'

export const LEG_MODES: Record<LegMode, string> = {
  manual: '手绘',
  snap: '贴合道路',
  foot: '步行',
  driving: '驾车',
  transit: '公共交通',
}

export function stopPoint(stop: RealStop): RoutePoint {
  return [stop.lng, stop.lat]
}

export function pathLength(points: RoutePoint[]): number {
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    const [a, b] = [points[index - 1], points[index]]
    total += haversine(a[1], a[0], b[1], b[0])
  }
  return total
}

export function legPath(plan: RealRouteDraft, index: number): RoutePoint[] {
  const leg = plan.legs[index]
  return leg.line ?? [stopPoint(plan.stops[index]), ...leg.guide, stopPoint(plan.stops[index + 1])]
}

export function planPath(plan: RealRouteDraft): RoutePoint[] {
  return plan.legs.flatMap((_, index) => legPath(plan, index).slice(index === 0 ? 0 : 1))
}

export function currentRouteLeg(itinerary: RouteItinerary): number {
  const legs = itinerary.plan?.legs
  if (!legs?.length) return 0
  if ((itinerary.progress ?? 0) >= 1) return -1
  let remaining = pathLength(planPath(itinerary.plan!)) * (itinerary.progress ?? 0)
  for (let index = 0; index < legs.length - 1; index += 1) {
    const length = pathLength(legPath(itinerary.plan!, index))
    if (remaining < length - 0.01) return index
    remaining -= length
  }
  return legs.length - 1
}

export function itineraryLegPois(leg: RealRouteDraft['legs'][number], scoped: boolean) {
  return (scoped ? leg.poisInRange ?? leg.pois : leg.pois) ?? []
}

export function editableRoute(itinerary: RouteItinerary): RealRouteDraft {
  if (itinerary.plan) return structuredClone(itinerary.plan)
  return {
    stops: [itinerary.from, itinerary.to],
    legs: [{ mode: itinerary.profile, guide: [], steps: itinerary.steps }],
  }
}

export function validRealRoute(raw: unknown): RealRouteDraft | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const plan = raw as RealRouteDraft
  if (!Array.isArray(plan.stops) || !Array.isArray(plan.legs) || plan.stops.length !== plan.legs.length + 1) return undefined
  const validPoint = (point: unknown): point is RoutePoint =>
    Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)
  if (!plan.stops.every((stop) => stop && typeof stop.name === 'string' && validPoint([stop.lng, stop.lat]))) return undefined
  if (!plan.legs.every((leg) => leg && Object.hasOwn(LEG_MODES, leg.mode) &&
    Array.isArray(leg.guide) && leg.guide.every(validPoint) &&
    (leg.line === undefined || (Array.isArray(leg.line) && leg.line.length >= 2 && leg.line.every(validPoint))))) return undefined
  return plan
}
