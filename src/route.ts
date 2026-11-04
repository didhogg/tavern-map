import { haversine } from './geo'
import { fetchJson } from './http'
import type { LatLng, RouteProfile } from './types'

export type RouteStep = {
  instruction: string
  name?: string
  /** Exact OSM road/path name for this segment, when available. */
  road?: string
  distance: number
  duration: number
  /** Geometry of this leg, used to attach route POIs to the right segment. */
  coordinates?: Array<[number, number]>
}

export type Route = {
  distance: number
  duration: number
  /** [longitude, latitude] pairs. */
  coordinates: Array<[number, number]>
  steps: RouteStep[]
  profile: RouteProfile
  fallback?: boolean
}

type OsrmStep = {
  distance?: number
  duration?: number
  name?: string
  ref?: string
  mode?: string
  geometry?: { coordinates?: number[][] }
  maneuver?: { type?: string; modifier?: string; exit?: number }
}

type OsrmResponse = {
  code?: string
  routes?: Array<{
    distance?: number
    duration?: number
    geometry?: { coordinates?: number[][] }
    legs?: Array<{ steps?: OsrmStep[] }>
  }>
}

function pair(from: LatLng, to: LatLng): string {
  return `${from.lng},${from.lat};${to.lng},${to.lat}`
}

const FOOT_ENDPOINTS = [
  (from: LatLng, to: LatLng) =>
    `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${pair(from, to)}?overview=full&geometries=geojson&steps=true`,
  (from: LatLng, to: LatLng) =>
    `https://router.project-osrm.org/route/v1/foot/${pair(from, to)}?overview=full&geometries=geojson&steps=true`,
]

const DRIVING_ENDPOINTS = [
  (from: LatLng, to: LatLng) =>
    `https://routing.openstreetmap.de/routed-car/route/v1/driving/${pair(from, to)}?overview=full&geometries=geojson&steps=true`,
  (from: LatLng, to: LatLng) =>
    `https://router.project-osrm.org/route/v1/driving/${pair(from, to)}?overview=full&geometries=geojson&steps=true`,
]

const MODIFIERS: Record<string, string> = {
  left: '左转',
  right: '右转',
  straight: '直行',
  'slight left': '稍向左',
  'slight right': '稍向右',
  'sharp left': '急左转',
  'sharp right': '急右转',
  uturn: '掉头',
}

const MANEUVERS: Record<string, string> = {
  merge: '汇入',
  fork: '走岔路',
  'end of road': '到道路尽头',
  'new name': '继续',
  continue: '继续',
  'use lane': '保持车道',
}

function instruction(step: OsrmStep): string {
  const type = step.maneuver?.type
  const modifier = step.maneuver?.modifier
  if (type === 'depart') return '出发'
  if (type === 'arrive') return '到达目的地'
  if (type === 'roundabout' || type === 'rotary' || type === 'roundabout turn') {
    const exit = step.maneuver?.exit
    return `进入环岛${exit ? `，第 ${exit} 个出口` : ''}`
  }
  if (type === 'continue') return '继续前进'
  const modifierLabel = modifier ? MODIFIERS[modifier] : ''
  if (modifierLabel) return modifierLabel
  const maneuverLabel = type ? MANEUVERS[type] : ''
  if (maneuverLabel) return maneuverLabel
  return '继续前进'
}

function roadName(step: OsrmStep): string | undefined {
  return step.name?.trim() || step.ref?.trim() || undefined
}

function parseSteps(raw: OsrmStep[] | undefined, profile: RouteProfile): RouteStep[] {
  const steps: RouteStep[] = []
  for (const item of raw ?? []) {
    const text = instruction(item)
    const road = roadName(item) ?? (profile === 'foot' ? '未命名步道' : '未命名道路')
    const distance = Number.isFinite(item.distance) ? Number(item.distance) : 0
    const duration = Number.isFinite(item.duration) ? Number(item.duration) : 0
    const coordinates = (item.geometry?.coordinates ?? [])
      .filter(
        (point): point is [number, number] =>
          Array.isArray(point) &&
          point.length >= 2 &&
          Number.isFinite(point[0]) &&
          Number.isFinite(point[1]),
      )
      .map((point) => [point[0], point[1]] as [number, number])
    if (
      steps.length > 0 &&
      steps[steps.length - 1].instruction === text &&
      steps[steps.length - 1].road === road &&
      steps[steps.length - 1].coordinates?.length === coordinates.length
    ) {
      const previous = steps[steps.length - 1]
      previous.distance += distance
      previous.duration += duration
      continue
    }
    steps.push({
      instruction: text,
      road,
      name: road,
      distance,
      duration,
      coordinates: coordinates.length >= 2 ? coordinates : undefined,
    })
    if (steps.length >= 40) break
  }
  return steps
}

async function roadRoute(from: LatLng, to: LatLng, profile: 'foot' | 'driving'): Promise<Route> {
  const endpoints = profile === 'driving' ? DRIVING_ENDPOINTS : FOOT_ENDPOINTS
  for (const endpoint of endpoints) {
    try {
      const data = await fetchJson<OsrmResponse>(
        endpoint(from, to),
        { headers: { Accept: 'application/json' } },
        10000,
      )
      const route = data.routes?.[0]
      const raw = route?.geometry?.coordinates
      if (data.code !== 'Ok' || !route || !raw || raw.length < 2) throw new Error('路线为空')
      const coordinates = raw
        .filter(
          (point): point is [number, number] =>
            Array.isArray(point) &&
            point.length >= 2 &&
            Number.isFinite(point[0]) &&
            Number.isFinite(point[1]),
        )
        .map((point) => [point[0], point[1]] as [number, number])
      if (coordinates.length < 2) throw new Error('路线坐标无效')
      return {
        distance: route.distance ?? haversine(from.lat, from.lng, to.lat, to.lng),
        duration:
          route.duration ??
          (route.distance ?? 0) / (profile === 'driving' ? 13.9 : 1.35),
        coordinates,
        steps: parseSteps(route.legs?.[0]?.steps, profile),
        profile,
      }
    } catch (error) {
      console.warn(`[tavern-map] ${profile} route endpoint failed`, error)
    }
  }

  const distance = haversine(from.lat, from.lng, to.lat, to.lng)
  const speed = profile === 'driving' ? 13.9 : 1.35
  return {
    distance,
    duration: distance / speed,
    coordinates: [
      [from.lng, from.lat],
      [to.lng, to.lat],
    ],
    steps: [
      {
        instruction: '路线服务不可用，按直线前往目的地',
        distance,
        duration: distance / speed,
      },
    ],
    profile,
    fallback: true,
  }
}

type MotisLeg = {
  mode?: string
  routeShortName?: string
  routeLongName?: string
  headsign?: string
  startTime?: string
  endTime?: string
  duration?: number
  distance?: number
  from?: { name?: string; lat?: number; lon?: number }
  to?: { name?: string; lat?: number; lon?: number }
  legGeometry?: { points?: string; precision?: number }
}

type MotisItinerary = {
  duration?: number
  startTime?: string
  endTime?: string
  transfers?: number
  legs?: MotisLeg[]
}

type MotisResponse = {
  itineraries?: MotisItinerary[]
}

const TRANSIT_MODE_LABELS: Record<string, string> = {
  WALK: '步行',
  BIKE: '骑行',
  BUS: '公交',
  COACH: '长途巴士',
  TRAM: '有轨电车',
  SUBWAY: '地铁',
  METRO: '地铁',
  REGIONAL_RAIL: '区域铁路',
  RAIL: '铁路',
  HIGHSPEED_RAIL: '高铁',
  LONG_DISTANCE: '长途列车',
  NIGHT_RAIL: '夜间列车',
  FERRY: '轮渡',
  CABLE_CAR: '缆车',
  FUNICULAR: '缆索铁路',
  AERIAL_LIFT: '索道',
  TROLLEYBUS: '无轨电车',
  SHARE_TAXI: '拼车',
}

function transitModeLabel(mode: string | undefined): string {
  return TRANSIT_MODE_LABELS[mode ?? ''] ?? mode ?? '公共交通'
}

/** Decode a Google/Mapbox-style polyline. MOTIS uses precision 6 by default. */
function decodePolyline(points: string, precision = 6): Array<[number, number]> {
  const coordinates: Array<[number, number]> = []
  let index = 0
  let lat = 0
  let lng = 0
  const factor = 10 ** precision
  while (index < points.length) {
    let result = 0
    let shift = 0
    let byte = 0
    do {
      byte = points.charCodeAt(index++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)
    lat += result & 1 ? ~(result >> 1) : result >> 1
    result = 0
    shift = 0
    do {
      byte = points.charCodeAt(index++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)
    lng += result & 1 ? ~(result >> 1) : result >> 1
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      coordinates.push([lng / factor, lat / factor])
    }
  }
  return coordinates
}

function lineLength(coordinates: Array<[number, number]>): number {
  let distance = 0
  for (let index = 1; index < coordinates.length; index += 1) {
    const [lng1, lat1] = coordinates[index - 1]
    const [lng2, lat2] = coordinates[index]
    distance += haversine(lat1, lng1, lat2, lng2)
  }
  return distance
}

function appendPoint(
  coordinates: Array<[number, number]>,
  lng: number | undefined,
  lat: number | undefined,
): void {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return
  const last = coordinates[coordinates.length - 1]
  if (last && Math.abs(last[0] - lng!) < 1e-7 && Math.abs(last[1] - lat!) < 1e-7) return
  coordinates.push([lng!, lat!])
}

async function transitRoute(from: LatLng, to: LatLng): Promise<Route> {
  const params = new URLSearchParams({
    fromPlace: `${from.lat},${from.lng}`,
    toPlace: `${to.lat},${to.lng}`,
    time: new Date().toISOString(),
    numItineraries: '3',
  })
  const data = await fetchJson<MotisResponse>(
    `https://api.transitous.org/api/v6/plan?${params.toString()}`,
    { headers: { Accept: 'application/json' } },
    20000,
  )
  const itinerary = data.itineraries?.[0]
  const legs = itinerary?.legs
  if (!itinerary || !Array.isArray(legs) || legs.length === 0) {
    throw new Error('没有可用的公共交通路线')
  }

  const coordinates: Array<[number, number]> = []
  const steps: RouteStep[] = []
  let stepDuration = 0
  let previousEndTime: number | null = null

  const lineLabel = (line: MotisLeg): string => {
    const name = line.routeShortName || line.routeLongName || ''
    return `${name ? `${name} ` : ''}${transitModeLabel(line.mode)}`
  }
  const pushStep = (step: RouteStep): void => {
    if (steps.length < 40) steps.push(step)
  }

  for (let index = 0; index < legs.length; index += 1) {
    const leg = legs[index]
    const previous = legs[index - 1]
    const next = legs[index + 1]
    const geometry = leg.legGeometry
    const stepCoordinates: Array<[number, number]> = []
    if (geometry?.points) {
      for (const point of decodePolyline(geometry.points, geometry.precision ?? 6)) {
        appendPoint(stepCoordinates, point[0], point[1])
        appendPoint(coordinates, point[0], point[1])
      }
    } else {
      appendPoint(stepCoordinates, leg.from?.lon, leg.from?.lat)
      appendPoint(stepCoordinates, leg.to?.lon, leg.to?.lat)
      appendPoint(coordinates, leg.from?.lon, leg.from?.lat)
      appendPoint(coordinates, leg.to?.lon, leg.to?.lat)
    }

    const duration = Number.isFinite(leg.duration) ? Number(leg.duration) : 0
    const distance = Number.isFinite(leg.distance) ? Number(leg.distance) : 0
    const startName = leg.from?.name?.trim() || '起点'
    const endName = leg.to?.name?.trim() || '终点'
    stepDuration += duration

    if (leg.mode === 'WALK') {
      const previousIsTransit = Boolean(previous && previous.mode !== 'WALK')
      const nextIsTransit = Boolean(next && next.mode !== 'WALK')
      if (previousIsTransit && nextIsTransit) {
        const nextLabel = next ? lineLabel(next) : '下一班公共交通'
        const heading = next?.headsign ? `（${next.headsign}）` : ''
        pushStep({
          instruction: `在 ${endName} 换乘 ${nextLabel}${heading}`,
          distance,
          duration,
          coordinates: stepCoordinates.length >= 2 ? stepCoordinates : undefined,
        })
      } else {
        pushStep({
          instruction: `步行到 ${endName}`,
          distance,
          duration,
          coordinates: stepCoordinates.length >= 2 ? stepCoordinates : undefined,
        })
      }
    } else {
      const startMs = Date.parse(leg.startTime ?? '')
      if (previousEndTime != null && Number.isFinite(startMs)) {
        const waitMinutes = Math.max(0, Math.round((startMs - previousEndTime) / 60000))
        if (waitMinutes >= 1) {
          pushStep({
            instruction: `在 ${startName} 等待约 ${waitMinutes} 分钟`,
            distance: 0,
            duration: waitMinutes * 60,
          })
        }
      }
      const line = leg.routeShortName || leg.routeLongName || ''
      const mode = transitModeLabel(leg.mode)
      const heading = leg.headsign ? `（${leg.headsign}）` : ''
      pushStep({
        instruction: `乘坐 ${line ? `${line} ` : ''}${mode}${heading} 从 ${startName} 到 ${endName}`,
        name: line || undefined,
        distance,
        duration,
        coordinates: stepCoordinates.length >= 2 ? stepCoordinates : undefined,
      })
    }

    const endMs = Date.parse(leg.endTime ?? '')
    if (Number.isFinite(endMs)) previousEndTime = endMs
  }

  if (coordinates.length < 2) throw new Error('公共交通路线没有可用几何')
  const distance = lineLength(coordinates) || haversine(from.lat, from.lng, to.lat, to.lng)
  return {
    distance,
    duration: itinerary.duration ?? stepDuration,
    coordinates,
    steps,
    profile: 'transit',
  }
}

function transitFallback(from: LatLng, to: LatLng): Route {
  const distance = haversine(from.lat, from.lng, to.lat, to.lng)
  return {
    distance,
    duration: distance / 8,
    coordinates: [
      [from.lng, from.lat],
      [to.lng, to.lat],
    ],
    steps: [
      {
        instruction: '公共交通路线服务不可用，按直线估算；出发前请以实际班次为准',
        distance,
        duration: distance / 8,
      },
    ],
    profile: 'transit',
    fallback: true,
  }
}

/** Public street/transit routing with a clear straight-line fallback. */
export async function routeBetween(
  from: LatLng,
  to: LatLng,
  profile: RouteProfile = 'foot',
): Promise<Route> {
  if (profile === 'transit') {
    try {
      return await transitRoute(from, to)
    } catch (error) {
      console.warn('[tavern-map] public transit route failed', error)
      return transitFallback(from, to)
    }
  }
  return roadRoute(from, to, profile)
}
