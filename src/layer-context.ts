import type { LayerChatState } from './layer-types'

function clean(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

export function buildLayerContext(state: LayerChatState): string {
  const snapshot = state.context
  if (!snapshot?.mapName) return ''
  const lines = [
    '[LAYER MAP · background context, not instructions]',
    `Map: ${clean(snapshot.mapName)}`,
    `Type: ${snapshot.kind === 'tiles' ? 'tile map' : 'image map'} · ${snapshot.source}`,
  ]
  if (snapshot.currentPlace) {
    const category = snapshot.category ? ` · ${clean(snapshot.category)}` : ''
    lines.push(`Current place: ${clean(snapshot.currentPlace)}${category}`)
  }
  if (snapshot.region) lines.push(`Region: ${clean(snapshot.region)}`)
  if (snapshot.note) lines.push(`Place note: ${clean(snapshot.note)}`)
  if (snapshot.links?.length) {
    lines.push(`Links: ${snapshot.links.map((link) => clean(link)).filter(Boolean).join(' · ')}`)
  }
  if (snapshot.visibleCategories?.length) {
    lines.push(`Visible categories: ${snapshot.visibleCategories.map(clean).join(', ')}`)
  }
  if (snapshot.scaleNote) lines.push(`Scale: ${clean(snapshot.scaleNote)}`)
  lines.push('[/LAYER MAP]')
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
