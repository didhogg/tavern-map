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

/**
 * Wikipedia plaintext contains trailing editorial sections that are not useful
 * for roleplay. Drop those sections (heading + body) from the AI context only;
 * the reader can still show the original article.
 */
const WIKI_BOILERPLATE_HEADINGS = new Set([
  'further reading',
  'further information',
  'references',
  'external links',
  'see also',
  'notes',
  'bibliography',
  'citations',
  'sources',
  'footnotes',
  'works cited',
  '延伸阅读',
  '进一步阅读',
  '参考文献',
  '参考资料',
  '外部链接',
  '外部連結',
  '参见',
  '參見',
  '相关条目',
  '相關條目',
  '注释',
  '註釋',
  '脚注',
  '腳註',
  '来源',
  '來源',
  '参考',
  '參考',
  '书目',
  '書目',
  '引用',
  '関連項目',
  '関連記事',
  '参考文献',
  '外部リンク',
  '脚注',
  '注釈',
  '出典',
])

export function stripWikiBoilerplate(text: string): string {
  const lines = text.split(/\r?\n/)
  const kept: string[] = []
  let skipLevel = 0
  for (const line of lines) {
    const heading = line.match(/^\s*(={2,})\s*(.+?)\s*={2,}\s*$/)
    if (heading) {
      const level = heading[1].length
      if (skipLevel > 0 && level > skipLevel) continue
      const name = heading[2].replace(/[_\s]+/g, ' ').trim().toLowerCase()
      if (WIKI_BOILERPLATE_HEADINGS.has(name)) {
        skipLevel = level
        continue
      }
      skipLevel = 0
      kept.push(line)
      continue
    }
    if (skipLevel === 0) kept.push(line)
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
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
    const currentNote =
      (currentKey ? state.placeNotes?.[currentKey]?.note : undefined) ?? currentSaved?.note
    if (currentNote) lines.push(`Place note: ${clean(currentNote)}`)
  }
  lines.push(`Coords: ${state.center.lat.toFixed(5)}, ${state.center.lng.toFixed(5)}`)
  if (nearby.length > 0) {
    lines.push(`Nearby: ${nearby.map(formatPlace).join(' · ')}`)
  }
  if (poiBriefs.length > 0) {
    lines.push('POI briefs:')
    for (const brief of poiBriefs) {
      const category = brief.category ? ` (${clean(brief.category)})` : ''
      const distance = brief.distanceM == null ? '' : `, ${formatDistance(brief.distanceM)}`
      const cuisine = brief.cuisine ? `, cuisine: ${clean(brief.cuisine)}` : ''
      const hours = brief.openingHours ? `, hours: ${clean(brief.openingHours)}` : ''
      const address = brief.address ? ` — ${clean(brief.address)}` : ''
      const chinese = brief.nameZh ? ` / ${clean(brief.nameZh)}` : ''
      lines.push(
        `- ${clean(brief.name)}${chinese}${category}${distance}${cuisine}${hours}${address}`,
      )
    }
  }
  const otherSaved = savedPlaces.filter((place) => placeKey(place) !== currentKey)
  if (otherSaved.length > 0) {
    lines.push('Saved places:')
    for (const place of otherSaved) {
      const category = place.category ? ` (${clean(place.category)})` : ''
      const chinese = place.nameZh ? ` / ${clean(place.nameZh)}` : ''
      const cuisine = place.cuisine ? `, cuisine: ${clean(place.cuisine)}` : ''
      const hours = place.openingHours ? `, hours: ${clean(place.openingHours)}` : ''
      const noteText = state.placeNotes?.[placeKey(place)]?.note ?? place.note
      const note = noteText ? ` — note: ${clean(noteText)}` : ''
      lines.push(`- ${clean(place.name)}${chinese}${category}${cuisine}${hours}${note}`)
    }
  }
  if (stars.length > 0) {
    lines.push('Wiki (starred):')
    for (const page of stars) {
      const hasAiLang = Boolean(page.aiLang)
      const lang = hasAiLang ? page.aiLang : page.lang
      const title = hasAiLang ? page.aiTitle || page.title : page.title
      const fullText = page.contextMode === 'full'
        ? hasAiLang
          ? page.aiFullText
          : page.fullText
        : undefined
      // Never fall back to the display-language body when an AI language is set:
      // a single saved article must produce exactly one language in the prompt.
      const body = hasAiLang ? page.aiExtract : page.extract
      const text = stripWikiBoilerplate(fullText || body || '')
      if (!text) continue
      const language = lang ? `[${lang.toUpperCase()}] ` : ''
      const note = page.note ? ` — note: ${clean(page.note)}` : ''
      const mode = fullText ? ' · full text' : ''
      lines.push(
        `- ${language}${clean(title)} (CC BY-SA 4.0)${mode}${note}: ${text}`,
      )
    }
  }
  if (state.itinerary?.showToAI) {
    const itinerary = state.itinerary
    const mode =
      itinerary.profile === 'driving'
        ? 'driving'
        : itinerary.profile === 'transit'
          ? 'public transit'
          : 'walking'
    const kind = itinerary.fallback ? `${mode} · straight-line estimate` : mode
    lines.push(`Route (current itinerary, ${kind}):`)
    lines.push(`From: ${clean(itinerary.from.name)} → ${clean(itinerary.to.name)}`)
    lines.push(`Distance: ${formatDistance(itinerary.distance)} · ${formatDuration(itinerary.duration)}`)
    for (const [index, step] of routeSteps.entries()) {
      const road = step.road ? ` — ${clean(step.road)}` : ''
      const stepDistance = step.distance > 0 ? ` (${formatDistance(step.distance)})` : ''
      lines.push(`${index + 1}. ${clean(step.instruction)}${road}${stepDistance}`)
      for (const poi of step.pois ?? []) {
        const category = poi.category ? ` (${clean(poi.category)})` : ''
        const cuisine = poi.cuisine ? `, cuisine: ${clean(poi.cuisine)}` : ''
        const chinese = poi.nameZh ? ` / ${clean(poi.nameZh)}` : ''
        const toLeg =
          poi.distanceM == null ? '' : ` — ${formatDistance(poi.distanceM)} from this leg`
        const along =
          poi.alongM == null ? '' : `, ${formatDistance(poi.alongM)} from its start`
        lines.push(`   - ${clean(poi.name)}${chinese}${category}${cuisine}${toLeg}${along}`)
      }
    }
  }
  lines.push('[/SCENE MAP]')
  return lines.join('\n')
}

/**
 * Build a deterministic scene block. No character/token trimming: Wiki intros,
 * full text, notes, POI briefs, saved places and route steps are all included.
 * The token estimate is display-only.
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

  const nearby = state.nearby.slice(0, Math.max(0, settings.maxNearby))
  const savedPlaces = state.savedPlaces
  const poiBriefs = state.poiAllToAI ? state.poiBriefs : []
  const stars = state.stars.filter((page) =>
    page.aiLang
      ? Boolean(page.aiFullText || page.aiExtract)
      : Boolean(page.fullText || page.extract),
  )
  const routeSteps = state.itinerary?.showToAI
    ? settings.showRoutePois
      ? state.itinerary.steps
      : state.itinerary.steps.map((step) => ({ ...step, pois: [] }))
    : []

  return render(state, nearby, savedPlaces, stars, poiBriefs, routeSteps)
}
