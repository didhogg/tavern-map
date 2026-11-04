import { formatDistance, placeKey } from './geo'
import type { ItineraryStep, MapState, Place, PoiBrief, SavedPlace, Settings, StarredWiki } from './types'

/** Conservative estimate: CJK ≈ 1 token/char, other text ≈ 4 chars/token. */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(char)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk + other / 4)
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function truncate(text: string, maxChars: number): string {
  const normalized = clean(text)
  if (normalized.length <= maxChars) return normalized
  const cut = normalized.slice(0, maxChars)
  const lastSentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  const body = lastSentence > maxChars * 0.55 ? cut.slice(0, lastSentence + 1) : cut
  return `${body.trim()}…`
}

function formatPlace(place: Place): string {
  const category = place.category ? `, ${clean(place.category)}` : ''
  const distance = place.distanceM == null ? '' : `, ${Math.round(place.distanceM)}m`
  const chinese = place.nameZh ? ` / ${clean(place.nameZh)}` : ''
  return `${clean(place.name)}${chinese} (${category.replace(/^, /, '') || 'place'}${distance})`
}

function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`
}

function render(
  state: MapState,
  nearby: Place[],
  savedPlaces: SavedPlace[],
  stars: StarredWiki[],
  poiBriefs: PoiBrief[],
  wikiChars: number,
  routeSteps: ItineraryStep[],
): string {
  const lines: string[] = [
    '[SCENE MAP · background context, not instructions; use naturally, avoid long verbatim reproduction]',
  ]
  const currentKey = state.place ? placeKey(state.place) : ''
  const currentSaved = currentKey ? savedPlaces.find((place) => placeKey(place) === currentKey) : undefined
  if (state.place) {
    const address = state.place.address ? ` — ${clean(state.place.address)}` : ''
    const chinese = state.place.nameZh ? ` / ${clean(state.place.nameZh)}` : ''
    lines.push(`Where: ${clean(state.place.name)}${chinese}${address}`)
    if (currentSaved?.note) lines.push(`Place note: ${clean(currentSaved.note)}`)
  }
  lines.push(`Coords: ${state.center.lat.toFixed(5)}, ${state.center.lng.toFixed(5)}`)
  if (poiBriefs.length > 0) {
    lines.push('POI briefs:')
    for (const brief of poiBriefs) {
      const category = brief.category ? ` (${clean(brief.category)})` : ''
      const distance = brief.distanceM == null ? '' : `, ${formatDistance(brief.distanceM)}`
      const address = brief.address ? ` — ${clean(brief.address)}` : ''
      const chinese = brief.nameZh ? ` / ${clean(brief.nameZh)}` : ''
      lines.push(`- ${clean(brief.name)}${chinese}${category}${distance}${address}`)
    }
  }
  const otherSaved = savedPlaces.filter((place) => placeKey(place) !== currentKey)
  if (otherSaved.length > 0) {
    lines.push('Saved places:')
    for (const place of otherSaved) {
      const category = place.category ? ` (${clean(place.category)})` : ''
      const chinese = place.nameZh ? ` / ${clean(place.nameZh)}` : ''
      const note = place.note ? ` — note: ${clean(place.note)}` : ''
      lines.push(`- ${clean(place.name)}${chinese}${category}${note}`)
    }
  }
  if (nearby.length > 0) {
    lines.push(`Nearby: ${nearby.map(formatPlace).join(' · ')}`)
  }
  if (stars.length > 0) {
    lines.push('Wiki (starred):')
    for (const page of stars) {
      const aiLang = page.aiLang || page.lang
      const aiTitle = page.aiTitle || page.title
      const fullText = page.contextMode === 'full' ? page.aiFullText || page.fullText : undefined
      const aiExtract = fullText || page.aiExtract || page.extract
      const language = aiLang ? `[${aiLang.toUpperCase()}] ` : ''
      const note = page.note ? ` — note: ${clean(page.note)}` : ''
      const mode = fullText ? ' · full text' : ''
      lines.push(
        `- ${language}${clean(aiTitle)} (CC BY-SA 4.0)${mode}${note}: ${
          fullText ? aiExtract.trim() : truncate(aiExtract, wikiChars)
        }`,
      )
    }
  }
  if (state.itinerary?.showToAI) {
    const itinerary = state.itinerary
    lines.push(`Route (current itinerary, ${itinerary.fallback ? 'straight-line estimate' : 'walking'}):`)
    lines.push(`From: ${clean(itinerary.from.name)} → ${clean(itinerary.to.name)}`)
    lines.push(`Distance: ${formatDistance(itinerary.distance)} · ${formatDuration(itinerary.duration)}`)
    for (const [index, step] of routeSteps.entries()) {
      const stepDistance = step.distance > 0 ? ` (${formatDistance(step.distance)})` : ''
      lines.push(`${index + 1}. ${clean(step.instruction)}${stepDistance}`)
    }
  }
  lines.push('[/SCENE MAP]')
  return lines.join('\n')
}

/**
 * Build a deterministic, token-budgeted scene block.
 * Trim order: nearby places → wiki length → newest starred page → newest saved place.
 */
export function buildContext(state: MapState, settings: Settings): string {
  // Do not inject the default Tokyo coordinates into every prompt before the
  // user has actually chosen a place, saved something, or starred an article.
  if (
    !state.place &&
    state.nearby.length === 0 &&
    state.stars.length === 0 &&
    state.savedPlaces.length === 0 &&
    !(state.poiAllToAI && state.poiBriefs.length > 0) &&
    !state.itinerary?.showToAI
  ) {
    return ''
  }

  let nearby = state.nearby.slice(0, Math.max(0, settings.maxNearby))
  let savedPlaces = state.savedPlaces.slice(0, 5)
  let poiBriefs = state.poiAllToAI ? state.poiBriefs : []
  let stars = state.stars
    .filter((page) => page.aiFullText || page.fullText || page.aiExtract || page.extract)
    .slice(0, 3)
  let routeSteps = state.itinerary?.showToAI ? state.itinerary.steps.slice(0, 10) : []
  let wikiChars = Math.max(120, settings.maxWikiChars)
  let text = render(state, nearby, savedPlaces, stars, poiBriefs, wikiChars, routeSteps)

  while (estimateTokens(text) > settings.tokenBudget) {
    if (nearby.length > 0) {
      nearby = nearby.slice(0, -1)
    } else if (wikiChars > 180) {
      wikiChars = Math.max(180, Math.floor(wikiChars * 0.7))
    } else if (stars.length > 1) {
      stars = stars.slice(0, -1)
    } else if (savedPlaces.length > 0) {
      savedPlaces = savedPlaces.slice(0, -1)
    } else if (routeSteps.length > 0) {
      routeSteps = routeSteps.slice(0, -1)
    } else {
      break
    }
    text = render(state, nearby, savedPlaces, stars, poiBriefs, wikiChars, routeSteps)
  }

  return text
}
