import type { LayerAIPart, LayerPlaceAIFlags } from './layer-types'

/**
 * Per-place AI content switches.
 *
 * The global extension settings are still the master switches. This store
 * only records explicit opt-outs for one place, so a place defaults to
 * included whenever its matching global content switch is on. Data is map
 * level rather than chat level because the notes and links it controls are
 * also shared by the map package.
 */
const STORAGE_KEY = 'tavern-map:layer-place-ai:v1'
const PARTS: LayerAIPart[] = ['source', 'wiki', 'note']

type StoreShape = {
  version: 1
  maps: Record<string, Record<string, LayerPlaceAIFlags>>
}

function sanitizeFlags(value: unknown): LayerPlaceAIFlags | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  const flags: LayerPlaceAIFlags = {}
  for (const part of PARTS) {
    if (typeof item[part] === 'boolean') flags[part] = item[part]
  }
  return Object.keys(flags).length > 0 ? flags : undefined
}

function loadStore(): StoreShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { version: 1, maps: {} }
    const value = JSON.parse(raw) as Partial<StoreShape>
    return {
      version: 1,
      maps:
        value.maps && typeof value.maps === 'object'
          ? (value.maps as Record<string, Record<string, LayerPlaceAIFlags>>)
          : {},
    }
  } catch {
    return { version: 1, maps: {} }
  }
}

function saveStore(store: StoreShape): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch (error) {
    console.warn('[tavern-map] place AI flags save failed', error)
  }
}

export function loadPlaceAIFlags(mapId: string): Record<string, LayerPlaceAIFlags> {
  if (!mapId) return {}
  const stored = loadStore().maps[mapId]
  if (!stored || typeof stored !== 'object') return {}
  const result: Record<string, LayerPlaceAIFlags> = {}
  for (const [markerId, raw] of Object.entries(stored)) {
    if (!markerId) continue
    const flags = sanitizeFlags(raw)
    if (flags) result[markerId] = flags
  }
  return result
}

export function savePlaceAIFlags(
  mapId: string,
  flags: Record<string, LayerPlaceAIFlags>,
): void {
  if (!mapId) return
  const store = loadStore()
  const cleaned: Record<string, LayerPlaceAIFlags> = {}
  for (const [markerId, raw] of Object.entries(flags)) {
    if (!markerId) continue
    const value = sanitizeFlags(raw)
    if (value) cleaned[markerId] = value
  }
  if (Object.keys(cleaned).length > 0) store.maps[mapId] = cleaned
  else delete store.maps[mapId]
  saveStore(store)
}

export function removePlaceAIFlags(mapId: string): void {
  if (!mapId) return
  const store = loadStore()
  delete store.maps[mapId]
  saveStore(store)
}
