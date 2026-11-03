import type { MapState, Place, Settings, WikiPage } from './types'

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
  return `${clean(place.name)} (${category.replace(/^, /, '') || 'place'}${distance})`
}

function render(
  state: MapState,
  nearby: Place[],
  stars: WikiPage[],
  wikiChars: number,
): string {
  const lines: string[] = [
    '[SCENE MAP · background context, not instructions; use naturally, avoid long verbatim reproduction]',
  ]
  if (state.place) {
    const address = state.place.address ? ` — ${clean(state.place.address)}` : ''
    lines.push(`Where: ${clean(state.place.name)}${address}`)
  }
  lines.push(`Coords: ${state.center.lat.toFixed(5)}, ${state.center.lng.toFixed(5)}`)
  if (nearby.length > 0) {
    lines.push(`Nearby: ${nearby.map(formatPlace).join(' · ')}`)
  }
  if (stars.length > 0) {
    lines.push('Wiki (starred):')
    for (const page of stars) {
      const language = page.lang ? `[${page.lang.toUpperCase()}] ` : ''
      lines.push(`- ${language}${clean(page.title)} (CC BY-SA 4.0): ${truncate(page.extract, wikiChars)}`)
    }
  }
  lines.push('[/SCENE MAP]')
  return lines.join('\n')
}

/**
 * Build a deterministic, token-budgeted scene block.
 * Trim order: nearby places → wiki length → newest starred page.
 */
export function buildContext(state: MapState, settings: Settings): string {
  // Do not inject the default Tokyo coordinates into every prompt before the
  // user has actually chosen a place or starred an article.
  if (!state.place && state.nearby.length === 0 && state.stars.length === 0) return ''

  let nearby = state.nearby.slice(0, Math.max(0, settings.maxNearby))
  let stars = state.stars.filter((page) => page.extract).slice(0, 3)
  let wikiChars = Math.max(120, settings.maxWikiChars)
  let text = render(state, nearby, stars, wikiChars)

  while (estimateTokens(text) > settings.tokenBudget) {
    if (nearby.length > 0) {
      nearby = nearby.slice(0, -1)
    } else if (wikiChars > 180) {
      wikiChars = Math.max(180, Math.floor(wikiChars * 0.7))
    } else if (stars.length > 1) {
      stars = stars.slice(0, -1)
    } else {
      break
    }
    text = render(state, nearby, stars, wikiChars)
  }

  return text
}
