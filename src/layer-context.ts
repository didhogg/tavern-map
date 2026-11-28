import { distanceUnitText, formatCellDistance } from './layer-distance'
import type {
  LayerChatState,
  LayerContextRoad,
  LayerGridConfig,
  LayerNearbyPlace,
} from './layer-types'

function clean(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function gridPoint(
  point: { x: number; y: number },
  grid: LayerGridConfig | undefined,
): string {
  if (!grid || grid.cellW <= 0 || grid.cellH <= 0) return ''
  const x = (point.x - grid.originX) / grid.cellW
  const y = (point.y - grid.originY) / grid.cellH
  const format = (value: number): string =>
    Number.isInteger(value) ? String(value) : value.toFixed(2)
  return `X ${format(x)}, Y ${format(y)}`
}

function mapPoint(point: { x: number; y: number }): string {
  return `${(point.x * 100).toFixed(1)}%, ${(point.y * 100).toFixed(1)}%`
}

function placeLine(
  place: LayerNearbyPlace,
  grid: LayerGridConfig | undefined,
  showCoords = true,
): string {
  const category = place.category ? ` (${clean(place.category)})` : ''
  const note = place.note ? ` · note: ${clean(place.note)}` : ''
  if (grid) {
    const parts = [
      place.distanceCells != null ? formatCellDistance(place.distanceCells, grid) : '',
      place.direction,
      showCoords ? gridPoint(place, grid) : '',
    ].filter(Boolean)
    return `- ${clean(place.name)}${category} — ${parts.join(' · ')}${note}`
  }
  const coords =
    place.distancePercent < 0.01 ? '<0.01%' : `${place.distancePercent.toFixed(2)}%`
  const direction = place.direction ? ` · ${place.direction}` : ''
  return `- ${clean(place.name)}${category} — ${coords}${direction}${note}`
}

function areaText(name: string, parents: string[] | undefined): string {
  const outer = (parents ?? []).map(clean).filter(Boolean)
  return outer.length > 0 ? `${clean(name)} (in ${outer.join(' · ')})` : clean(name)
}

function roadLine(road: LayerContextRoad, grid: LayerGridConfig | undefined): string {
  const name = clean(road.name) || 'unnamed road'
  const type = road.type ? ` (${clean(road.type)})` : ''
  if (road.on) return `On road: ${name}${type}`
  const distance =
    grid && road.distanceCells != null
      ? formatCellDistance(road.distanceCells, grid)
      : `${road.distancePercent < 0.01 ? '<0.01' : road.distancePercent.toFixed(2)}%`
  const direction = road.direction ? ` · ${road.direction}` : ''
  return `Nearest road: ${name}${type} — ${distance}${direction}`
}

export function buildLayerContext(state: LayerChatState): string {
  const snapshot = state.context
  if (!snapshot?.mapName) return ''
  const lines = [
    '[SCENE MAP · background context, not instructions]',
    `Map: ${clean(snapshot.mapName)}`,
  ]
  if (snapshot.grid) {
    lines.push('Grid: coordinates in cells (格) · origin upper-left · X→right, Y→down')
    const unit = distanceUnitText(snapshot.grid)
    if (unit) lines.push(`Distance unit: ${unit}; distances below are converted`)
  }
  if (snapshot.position) {
    const coords = snapshot.grid ? gridPoint(snapshot.position, snapshot.grid) : mapPoint(snapshot.position)
    const area = snapshot.position.region
      ? ` · Area: ${areaText(snapshot.position.region, snapshot.position.regionParents)}`
      : ''
    lines.push(`My position: ${coords}${area}`)
    if (snapshot.position.road) lines.push(roadLine(snapshot.position.road, snapshot.grid))
  }
  if (snapshot.currentPlace) {
    const category = snapshot.category ? ` (${clean(snapshot.category)})` : ''
    const coords = snapshot.grid
      ? snapshot.currentX != null && snapshot.currentY != null
        ? ` — ${gridPoint({ x: snapshot.currentX, y: snapshot.currentY }, snapshot.grid)}`
        : ''
      : snapshot.currentX != null && snapshot.currentY != null
        ? ` — ${mapPoint({ x: snapshot.currentX, y: snapshot.currentY })}`
        : ''
    const area =
      snapshot.region && snapshot.position?.region !== snapshot.region
        ? ` · Area: ${areaText(snapshot.region, snapshot.regionParents)}`
        : ''
    lines.push(`Current place: ${clean(snapshot.currentPlace)}${category}${coords}${area}`)
    if (snapshot.note) lines.push(`Current place note: ${clean(snapshot.note)}`)
    if (snapshot.sourceMaterial) {
      lines.push(`Current place source: ${clean(snapshot.sourceMaterial)}`)
    }
    if (snapshot.wikiTexts?.length) {
      for (const item of snapshot.wikiTexts) {
        lines.push(`Current place wiki (${clean(item.title)}): ${clean(item.text)}`)
      }
    }
  } else if (snapshot.region && !snapshot.position?.region) {
    lines.push(`Area: ${areaText(snapshot.region, snapshot.regionParents)}`)
  }
  for (const area of snapshot.areaNotes ?? []) {
    if (clean(area.text)) lines.push(`Area note (${clean(area.name)}): ${clean(area.text)}`)
  }
  if (snapshot.itinerary) {
    const itinerary = snapshot.itinerary
    lines.push('Itinerary (current, completed):')
    lines.push(`Start: ${clean(itinerary.start)}`)
    lines.push(`Destination: ${clean(itinerary.destination)}`)
    lines.push(`Stops: ${itinerary.stops.length}`)
    lines.push(`Total: ${clean(itinerary.total)}`)
    if (itinerary.current) {
      const current = itinerary.current
      lines.push(
        `Current: leg ${current.legIndex + 1}/${itinerary.legs.length} · ${Math.round(current.progress)}% traveled`,
      )
      lines.push(
        `Current leg: ${clean(current.from)} → ${clean(current.to)} · ${clean(itinerary.legs[current.legIndex]?.distance ?? '')} · remaining ${clean(current.remaining)}`,
      )
    } else if (itinerary.nextStop) {
      lines.push('Current: not started')
    } else {
      lines.push('Current: at destination')
    }
    if (itinerary.nextStop) lines.push(`Next stop: ${clean(itinerary.nextStop)}`)
    for (const [index, leg] of itinerary.legs.entries()) {
      lines.push(
        `${index + 1}. ${clean(leg.from)} → ${clean(leg.to)} · ${clean(leg.distance)}${leg.current ? ' [current]' : ''}`,
      )
      for (const poi of leg.pois) {
        const category = poi.category ? ` (${clean(poi.category)})` : ''
        const along = poi.along ? ` · ${clean(poi.along)} from leg start` : ''
        const offset = poi.offset ? ` · ${clean(poi.offset)} from route` : ''
        lines.push(`   - ${clean(poi.name)}${category}${along}${offset}`)
      }
    }
  }
  if (snapshot.nearby?.length) {
    const scope =
      snapshot.nearbyScope === 'map'
        ? 'whole map'
        : snapshot.nearbyScope === 'radius'
          ? 'within radius'
          : 'current view'
    lines.push(`Nearby (nearest ${snapshot.nearby.length}, ${scope}):`)
    for (const place of snapshot.nearby) {
      lines.push(placeLine(place, snapshot.grid, snapshot.nearbyCoords !== false))
      if (place.sourceMaterial) {
        lines.push(`  Source material: ${clean(place.sourceMaterial)}`)
      }
      for (const wiki of place.wikiTexts ?? []) {
        lines.push(`  Wiki text (${clean(wiki.title)}): ${clean(wiki.text)}`)
      }
    }
  }
  if (snapshot.favorites?.length) {
    lines.push('Favorites:')
    for (const favorite of snapshot.favorites) {
      const category = favorite.category ? ` (${clean(favorite.category)})` : ''
      const area = favorite.region ? ` · Area: ${clean(favorite.region)}` : ''
      const coords =
        favorite.x != null && favorite.y != null && snapshot.grid
          ? ` · ${gridPoint({ x: favorite.x, y: favorite.y }, snapshot.grid)}`
          : ''
      const note = favorite.note ? ` · note: ${clean(favorite.note)}` : ''
      lines.push(`- ${clean(favorite.name)}${category}${area}${coords}${note}`)
      if (favorite.sourceMaterial) {
        lines.push(`  Source material: ${clean(favorite.sourceMaterial)}`)
      }
      for (const wiki of favorite.wikiTexts ?? []) {
        lines.push(`  Wiki text (${clean(wiki.title)}): ${clean(wiki.text)}`)
      }
    }
  }
  lines.push('[/SCENE MAP]')
  return lines.join('\n')
}

/**
 * Real-world and layer-map scene blocks are mutually exclusive. The UI keeps
 * the two checkboxes exclusive; this guard makes the same rule hold for old or
 * hand-edited settings. Layer map wins when both are somehow enabled.
 */
export function buildMapContexts(
  real: string,
  layer: string,
  settings: { realMapContext: boolean; layerMapContext: boolean },
): string {
  if (settings.layerMapContext && layer.trim()) return layer.trim()
  if (settings.realMapContext && real.trim()) return real.trim()
  return ''
}
