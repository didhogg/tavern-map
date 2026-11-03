import { haversine } from './geo'
import { fetchJson } from './http'
import type { LatLng } from './types'

export type RouteStep = {
  instruction: string
  name?: string
  distance: number
  duration: number
}

export type Route = {
  distance: number
  duration: number
  /** [longitude, latitude] pairs. */
  coordinates: Array<[number, number]>
  steps: RouteStep[]
  profile: 'foot'
  fallback?: boolean
}

type OsrmStep = {
  distance?: number
  duration?: number
  name?: string
  mode?: string
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
  const name = step.name?.trim()
  const type = step.maneuver?.type
  const modifier = step.maneuver?.modifier
  if (type === 'depart') return name ? `从 ${name} 出发` : '出发'
  if (type === 'arrive') return '到达目的地'
  if (type === 'roundabout' || type === 'rotary' || type === 'roundabout turn') {
    const exit = step.maneuver?.exit
    return `进入环岛${exit ? `，第 ${exit} 个出口` : ''}${name ? `，进入 ${name}` : ''}`
  }
  if (type === 'continue') return name ? `继续沿 ${name} 前进` : '继续前进'
  const modifierLabel = modifier ? MODIFIERS[modifier] : ''
  if (modifierLabel) return `${modifierLabel}${name ? `进入 ${name}` : ''}`
  const maneuverLabel = type ? MANEUVERS[type] : ''
  if (maneuverLabel) return `${maneuverLabel}${name ? `进入 ${name}` : ''}`
  return name ? `沿 ${name} 前进` : '继续前进'
}

function parseSteps(raw: OsrmStep[] | undefined): RouteStep[] {
  const steps: RouteStep[] = []
  for (const item of raw ?? []) {
    const text = instruction(item)
    const distance = Number.isFinite(item.distance) ? Number(item.distance) : 0
    const duration = Number.isFinite(item.duration) ? Number(item.duration) : 0
    if (steps.length > 0 && steps[steps.length - 1].instruction === text) {
      const previous = steps[steps.length - 1]
      previous.distance += distance
      previous.duration += duration
      continue
    }
    steps.push({ instruction: text, name: item.name, distance, duration })
    if (steps.length >= 40) break
  }
  return steps
}

/** Public OSRM foot routing with a straight-line fallback. */
export async function routeBetween(from: LatLng, to: LatLng): Promise<Route> {
  for (const endpoint of FOOT_ENDPOINTS) {
    try {
      const data = await fetchJson<OsrmResponse>(endpoint(from, to), { headers: { Accept: 'application/json' } }, 10000)
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
        duration: route.duration ?? (route.distance ?? 0) / 1.35,
        coordinates,
        steps: parseSteps(route.legs?.[0]?.steps),
        profile: 'foot',
      }
    } catch (error) {
      console.warn('[tavern-map] route endpoint failed', error)
    }
  }

  const distance = haversine(from.lat, from.lng, to.lat, to.lng)
  return {
    distance,
    duration: distance / 1.35,
    coordinates: [
      [from.lng, from.lat],
      [to.lng, to.lat],
    ],
    steps: [
      {
        instruction: '路线服务不可用，按直线前往目的地',
        distance,
        duration: distance / 1.35,
      },
    ],
    profile: 'foot',
    fallback: true,
  }
}
